// lib/sheets.js
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "CITAS";

// ========== Autenticación ==========
let credentials;
try {
  if (!process.env.GOOGLE_CREDENTIALS_BASE64) {
    throw new Error("Variable GOOGLE_CREDENTIALS_BASE64 no configurada");
  }
  const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8");
  credentials = JSON.parse(decoded);
} catch (err) {
  console.error("Error al decodificar GOOGLE_CREDENTIALS_BASE64:", err);
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

// ========== Utils ==========
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

// Timestamp Ecuador (America/Guayaquil)
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
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map((p) => [p.type, p.value]));
  const dd = parts.day, mm = parts.month, yyyy = parts.year;
  const HH = parts.hour.padStart(2, "0"), mi = parts.minute, ss = parts.second;
  return `${yyyy}-${mm}-${dd}T${HH}:${mi}:${ss}-05:00`;
}

// Mapeo de valores por encabezado dinámico
function valueByHeader(data, numeroCitaGenerado, observacionFinal) {
  return {
    numero_cita: () => numeroCitaGenerado,
    nombre_paciente: () => data.nombre_paciente || "",
    numero_cedula: () => data.numero_cedula || "",
    nombre_contacto: () => data.nombre_contacto || "",
    celular_contacto: () => data.celular_contacto || "",
    fecha_cita: () => data.fecha_cita || "",
    hora_cita: () => data.hora_cita || "",
    status_cita: () => data.status_cita || "",
    observaciones: () => observacionFinal
  };
}

// ========== Crear cita ==========
export async function createAppointment(data) {
  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);

    // Generar número de cita
    const numeroCitaGenerado = `CITA-${Date.now()}`;

    // Observaciones: incluir hora de cita (si hay) + timestamp EC
    const observacionFinal = `${data.hora_cita ? `Hora cita: ${data.hora_cita} | ` : ""}${nowGuayaquilISO()}`;

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
    console.error("[createAppointment] Error:", err);
    return null;
  }
}

// ========== Consultar por cédula ==========
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

    // Devuelve objeto con los nombres normalizados como claves
    const obj = {};
    normalized.forEach((h, idx) => {
      obj[h] = row[idx] ?? "";
    });
    return obj;
  } catch (err) {
    console.error("[findAppointmentByCedula] Error:", err);
    return null;
  }
}

// ========== Actualizar estado por cédula ==========
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
    console.error("[updateAppointmentStatusByCedula] Error:", err);
    return false;
  }
}

// ========== Disponibilidad de hora ==========
export async function isHoraDisponible(fecha, hora) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return true;

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const fechaIdx = headers.indexOf("fecha_cita");
    const horaIdx = headers.indexOf("hora_cita");
    if (fechaIdx === -1 || horaIdx === -1) return true;

    return !rows.some((row, i) => i > 0 && row[fechaIdx] === fecha && row[horaIdx] === hora);
  } catch (err) {
    console.error("[isHoraDisponible] Error:", err);
    return true; // en error, no bloquear
  }
}

export async function getHorasDisponibles(fecha) {
  try {
    // Genera rango 08:00 a 17:00 cada 60 min (puedes ajustar intervalos)
    const horas = [];
    for (let h = 8; h <= 17; h++) {
      const horaStr = `${String(h).padStart(2, "0")}:00`;
      horas.push(horaStr);
    }

    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return horas;

    const headers = rows[0].map((h) => h.trim().toLowerCase());
    const fechaIdx = headers.indexOf("fecha_cita");
    const horaIdx = headers.indexOf("hora_cita");
    if (fechaIdx === -1 || horaIdx === -1) return horas;

    const ocupadas = rows
      .filter((row, i) => i > 0 && row[fechaIdx] === fecha)
      .map((row) => row[horaIdx]);

    return horas.filter((h) => !ocupadas.includes(h));
  } catch (err) {
    console.error("[getHorasDisponibles] Error:", err);
    // En error, devolvemos el horario base
    const fallback = [];
    for (let h = 8; h <= 17; h++) fallback.push(`${String(h).padStart(2, "0")}:00`);
    return fallback;
  }
}
