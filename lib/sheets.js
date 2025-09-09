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
  // dd/mm/yyyy HH:mm:ss -> yyyy-mm-ddTHH:mm:ss-05:00 (sin calcular DST porque EC no usa)
  const dd = parts.day, mm = parts.month, yyyy = parts.year;
  const HH = parts.hour.padStart(2, "0"), mi = parts.minute, ss = parts.second;
  return `${yyyy}-${mm}-${dd}T${HH}:${mi}:${ss}-05:00`;
}

// Construir fila según encabezado real
function valueByHeader(data) {
  return {
    // Esquema actual de tu captura
    numero_dia: () => "", // si quieres, puedes poner el número de fila luego
    nombre_paciente: () => data.nombre_paciente || "",
    numero_cedula: () => data.numero_cedula || "",
    numero_contacto: () => data.nombre_contacto || "",
    celular_contacto: () => data.celular_contacto || "",
    fecha_dia: () => data.fecha_cita || "",
    status_dia: () => data.status_cita || "",
    observaciones: () => data.observaciones || nowGuayaquilISO(),

    // Esquema anterior compatible
    nombre_dba: () => data.nombre_paciente || "",
    nombre_gecahite: () => data.numero_cedula || "",
    fecha_dba: () => data.status_cita || "",
    status_dba: () => data.observaciones || "",

    // Sinónimos tolerantes
    fecha_cita: () => data.fecha_cita || "",
    estado: () => data.status_cita || "",
    notas: () => data.observaciones || ""
  };
}

// Crear cita
export async function createAppointment(data) {
  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);
    const mapping = valueByHeader(data);

    const row = normalized.map((h) => (mapping[h] ? mapping[h]() : ""));
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });

    const updatedRange = response.data?.updates?.updatedRange || ""; // e.g., CITAS!A5:Z5
    const match = updatedRange.match(/!A(\d+)/);
    return match ? match[1] : "N/A";
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
      ["numero_cedula", "cedula", "documento", "nombre_gecahite"].includes(h)
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

    // Map dinámico a tus llaves lógicas
    const obj = {};
    normalized.forEach((h, idx) => {
      const val = row[idx] ?? "";
      switch (h) {
        case "nombre_paciente":
        case "nombre_dba":
          obj.nombre_paciente = val; break;
        case "numero_cedula":
        case "cedula":
        case "documento":
        case "nombre_gecahite":
          obj.numero_cedula = val; break;
        case "numero_contacto":
        case "contacto":
          obj.nombre_contacto = val; break;
        case "nombre_contacto":
        case "telefono":
        case "celular":
        case "celular_contacto":
          obj.celular_contacto = val; break;
        case "fecha_dia":
        case "fecha_cita":
          obj.fecha_cita = val; break;
        case "status_dia":
        case "status_cita":
        case "estado":
        case "status_dba":
        case "fecha_dba":
          obj.status_cita = val; break;
        case "observaciones":
        case "observacion":
        case "notas":
          obj.observaciones = val; break;
        default:
          break;
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
      ["numero_cedula", "cedula", "documento", "nombre_gecahite"].includes(h)
    );
    const statusIdx = normalized.findIndex((h) =>
      ["status_dia", "status_cita", "estado", "status", "status_dba", "fecha_dba"].includes(h)
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
