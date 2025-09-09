// lib/sheets.js
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "CITAS";

// Decodificar credenciales JSON desde Base64
let credentials;
try {
  if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
    throw new Error("Variable GOOGLE_CREDENTIALS_BASE64 no configurada");
  }
  const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8");
  credentials = JSON.parse(decoded);
} catch (err) {
  console.error("💥 Error al decodificar GOOGLE_CREDENTIALS_BASE64:", err);
  credentials = {};
}

const GOOGLE_SERVICE_ACCOUNT_EMAIL = credentials.client_email;
const GOOGLE_PRIVATE_KEY = credentials.private_key;

function getSheetsClient() {
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

// Utils
const normalize = (s = "") =>
  s.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");

const colNumToLetter = (num) => {
  let s = "";
  while (num > 0) {
    const mod = (num - 1) % 26;
    s = String.fromCharCode(65 + mod) + s;
    num = Math.floor((num - mod) / 26);
  }
  return s;
};

async function getHeaders(sheets) {
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_TAB}!1:1`
  });
  const headers = (resp.data.values && resp.data.values[0]) || [];
  return { headers, normalized: headers.map(normalize) };
}

// Timestamp Ecuador
function nowGuayaquilISO() {
  const fmt = new Intl.DateTimeFormat("es-EC", {
    timeZone: "America/Guayaquil",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  const dd = parts.day, mm = parts.month, yyyy = parts.year;
  const HH = parts.hour.padStart(2, "0"), mi = parts.minute, ss = parts.second;
  return `${yyyy}-${mm}-${dd}T${HH}:${mi}:${ss}-05:00`;
}

// Construir fila según encabezado real
function valueByHeader(data, numeroCitaGenerado, observacionFinal) {
  return {
    numero_cita: () => numeroCitaGenerado,
    nombre_paciente: () => data.nombre_paciente || "",
    numero_cedula: () => data.numero_cedula || "",
    nombre_contacto: () => data.nombre_contacto || "",
    celular_contacto: () => data.celular_contacto || "",
    fecha_cita: () => data.fecha_cita || "",
    status_cita: () => data.status_cita || "",
    observaciones: () => observacionFinal
  };
}

// Crear cita
export async function createAppointment(data) {
  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);

    // Generar número de cita único
    const numeroCitaGenerado = `CITA-${Date.now()}`;

    // Extraer hora de la fecha_cita si existe
    let horaCita = "";
    if (data.fecha_cita) {
      const horaMatch = data.fecha_cita.match(/\b\d{1,2}:\d{2}\b/);
      if (horaMatch) horaCita = horaMatch[0];
    }

    // Observaciones: hora de cita (si hay) + timestamp Ecuador
    const observacionFinal = `${horaCita ? `Hora cita: ${horaCita} | ` : ""}${nowGuayaquilISO()}`;

    const mapping = valueByHeader(data, numeroCitaGenerado, observacionFinal);
    const row = normalized.map((h) => (mapping[h] ? mapping[h]() : ""));

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });

    return numeroCitaGenerado;
  } catch (err) {
    console.error("💥 [createAppointment] Error:", err);
    return null;
  }
}

// Consultar por cédula
export async function findAppointmentByCedula(cedula) {
  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);

    const cedulaIdx = normalized.findIndex((h) =>
      ["numero_cedula", "cedula", "documento"].includes(h)
    );
    if (cedulaIdx === -1) return null;

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return null;

    let row = null;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) {
        row = rows[i];
        break;
      }
    }
    if (!row) return null;

    const obj = {};
    normalized.forEach((h, idx) => {
      const val = row[idx] ?? "";
      switch (h) {
        case "numero_cita": obj.numero_cita = val; break;
        case "nombre_paciente": obj.nombre_paciente = val; break;
        case "numero_cedula": obj.numero_cedula = val; break;
        case "nombre_contacto": obj.nombre_contacto = val; break;
        case "celular_contacto": obj.celular_contacto = val; break;
        case "fecha_cita": obj.fecha_cita = val; break;
        case "status_cita": obj.status_cita = val; break;
        case "observaciones": obj.observaciones = val; break;
      }
    });

    return obj;
  } catch (err) {
    console.error("💥 [findAppointmentByCedula] Error:", err);
    return null;
  }
}

// Actualizar estado por cédula
export async function updateAppointmentStatusByCedula(cedula, nuevoEstado) {
  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);

    const cedulaIdx = normalized.findIndex((h) =>
      ["numero_cedula", "cedula", "documento"].includes(h)
    );
    const statusIdx = normalized.findIndex((h) =>
      ["status_cita", "estado", "status"].includes(h)
    );
    if (cedulaIdx === -1 || statusIdx === -1) return false;

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return false;

    let targetRowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) {
        targetRowIndex = i;
        break;
      }
    }
    if (targetRowIndex === -1) return false;

    const colLetter = colNumToLetter(statusIdx + 1);
    const range = `${SHEET_TAB}!${colLetter}${targetRowIndex + 1}`;

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[nuevoEstado]] }
    });
    return true;
  } catch (err) {
    console.error("💥 [updateAppointmentStatusByCedula] Error:", err);
    return false;
  }
}
