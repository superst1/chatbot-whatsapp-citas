// lib/sheets.js
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "CITAS";

/* ===== Autenticación Google Sheets ===== */
let credentials;
try {
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

/* ===== Utils ===== */
const normalize = (s = "") =>
  s
    .toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");

function getColIndex(normalizedHeaders, candidates) {
  const cand = candidates.map(normalize);
  return normalizedHeaders.findIndex((h) => cand.includes(h));
}

function colNumToLetter(colNum) {
  let letter = "";
  while (colNum > 0) {
    const mod = (colNum - 1) % 26;
    letter = String.fromCharCode(65 + mod) + letter;
    colNum = Math.floor((colNum - mod) / 26);
  }
  return letter;
}

function normalizarFecha(fecha) {
  if (!fecha) return "";
  if (fecha instanceof Date) {
    const dd = String(fecha.getDate()).padStart(2, "0");
    const mm = String(fecha.getMonth() + 1).padStart(2, "0");
    const yyyy = fecha.getFullYear();
    return `${dd}/${mm}/${yyyy}`;
  }
  const partes = String(fecha).trim().split(/[\/-]/);
  if (partes.length >= 3) {
    const dd = partes[0].padStart(2, "0");
    const mm = partes[1].padStart(2, "0");
    const yyyy = partes[2].length === 2 ? `20${partes[2]}` : partes[2];
    return `${dd}/${mm}/${yyyy}`;
  }
  return String(fecha).trim();
}

function normalizarHora(hora) {
  if (!hora) return "";
  const trimmed = String(hora).trim();
  const ampm = trimmed.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s?(am|pm)\b/i);
  if (ampm) {
    let hh = parseInt(ampm[1], 10);
    const mm = ampm[2] || "00";
    const period = ampm[3].toLowerCase();
    hh = hh % 12;
    if (period === "pm") hh += 12;
    return `${String(hh).padStart(2, "0")}:${mm}`;
  }
  const hhmm = trimmed.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) {
    const hh = String(parseInt(hhmm[1], 10)).padStart(2, "0");
    const mm = hhmm[2];
    return `${hh}:${mm}`;
  }
  return trimmed;
}

/* ===== Crear cita ===== */
export async function createAppointment(data) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!1:1`
    });
    const headers = resp.data.values?.[0] || [];
    const normalized = headers.map(normalize);

    const row = normalized.map((h) => {
      switch (h) {
        case "nombre_paciente":
          return data.nombre_paciente || "";
        case "numero_cedula":
          return data.numero_cedula || "";
        case "nombre_contacto":
          return data.nombre_contacto || "";
        case "celular_contacto":
          return data.celular_contacto || "";
        case "fecha_cita":
        case "fecha":
          return normalizarFecha(data.fecha_cita);
        case "hora_cita":
        case "hora":
          return normalizarHora(data.hora_cita);
        case "status_cita":
        case "estado":
          return data.status_cita || "pendiente";
        default:
          return "";
      }
    });

    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });

    return `CITA-${Date.now()}`;
  } catch (err) {
    console.error("[createAppointment] Error:", err);
    return null;
  }
}

/* ===== Disponibilidad ===== */
export async function isHoraDisponible(fecha, hora) {
  try {
    const fechaNorm = normalizarFecha(fecha);
    const horaNorm = normalizarHora(hora);

    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return true;

    const headers = rows[0];
    const normalized = headers.map(normalize);

    const fechaIdx = getColIndex(normalized, ["fecha_cita", "fecha"]);
    const horaIdx = getColIndex(normalized, ["hora_cita", "hora"]);
    if (fechaIdx === -1 || horaIdx === -1) return true;

    return !rows.some((row, i) => {
      if (i === 0) return false;
      return (
        normalizarFecha(row[fechaIdx]) === fechaNorm &&
        normalizarHora(row[horaIdx]) === horaNorm
      );
    });
  } catch (err) {
    console.error("[isHoraDisponible] Error:", err);
    return true;
  }
}

export async function getHorasDisponibles(fecha) {
  try {
    const fechaNorm = normalizarFecha(fecha);
    const horarioBase = [];
    for (let h = 8; h <= 17; h++) horarioBase.push(`${String(h).padStart(2, "0")}:00`);

    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return horarioBase;

    const headers = rows[0];
    const normalized = headers.map(normalize);

    const fechaIdx = getColIndex(normalized, ["fecha_cita", "fecha"]);
    const horaIdx = getColIndex(normalized, ["hora_cita", "hora"]);
    if (fechaIdx === -1 || horaIdx === -1) return horarioBase;

    const ocupadas = rows
      .filter((row, i) => i > 0 && normalizarFecha(row[fechaIdx]) === fechaNorm)
      .map((row) => normalizarHora(row[horaIdx]));

    return horarioBase.filter((h) => !ocupadas.includes(h));
  } catch (err) {
    console.error("[getHorasDisponibles] Error:", err);
    return [];
  }
}

/* ===== Consultar por cédula (opcional útil) ===== */
export async function findAppointmentByCedula(cedula) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });

    const rows = resp.data.values || [];
    if (rows.length <= 1) return null;

    const headers = rows[0];
    const normalized = headers.map(normalize);

    const cedulaIdx = getColIndex(normalized, ["numero_cedula", "cedula", "documento"]);
    if (cedulaIdx === -1) return null;

    const objFromRow = (row) => {
      const o = {};
      headers.forEach((h, i) => (o[normalize(h)] = row[i]));
      return o;
    };

    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) {
        return objFromRow(rows[i]);
      }
    }
    return null;
  } catch (err) {
    console.error("[findAppointmentByCedula] Error:", err);
    return null;
  }
}

/* ===== Re-agendar ===== */
export async function updateAppointmentByCedula(cedula, nuevosDatos) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });

    const rows = resp.data.values || [];
    if (rows.length <= 1) return false;

    const headers = rows[0];
    const normalized = headers.map(normalize);

    const cedulaIdx = getColIndex(normalized, ["numero_cedula", "cedula", "documento"]);
    if (cedulaIdx === -1) return false;

    // Buscar fila
    let targetRowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) {
        targetRowIndex = i;
        break;
      }
    }
    if (targetRowIndex === -1) return false;

    // Actualizar columnas presentes
    for (const [campo, valor] of Object.entries(nuevosDatos)) {
      const colIdx = getColIndex(normalized, [campo]);
      if (colIdx !== -1 && valor !== undefined && valor !== null && String(valor).trim() !== "") {
        const colLetter = colNumToLetter(colIdx + 1);
        const range = `${SHEET_TAB}!${colLetter}${targetRowIndex + 1}`;
        const writeValue =
          campo.toLowerCase().includes("fecha")
            ? normalizarFecha(valor)
            : campo.toLowerCase().includes("hora")
            ? normalizarHora(valor)
            : valor;

        await sheets.spreadsheets.values.update({
          spreadsheetId: SPREADSHEET_ID,
          range,
          valueInputOption: "USER_ENTERED",
          requestBody: { values: [[writeValue]] }
        });
      }
    }

    return true;
  } catch (err) {
    console.error("[updateAppointmentByCedula] Error:", err);
    return false;
  }
}

/* ===== Cancelar / cambiar estado ===== */
export async function updateAppointmentStatusByCedula(cedula, nuevoEstado) {
  try {
    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });

    const rows = resp.data.values || [];
    if (rows.length <= 1) return false;

    const headers = rows[0];
    const normalized = headers.map(normalize);

    const cedulaIdx = getColIndex(normalized, ["numero_cedula", "cedula", "documento"]);
    const estadoIdx = getColIndex(normalized, ["status_cita", "estado"]);
    if (cedulaIdx === -1 || estadoIdx === -1) return false;

    // Buscar fila
    let targetRowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) {
        targetRowIndex = i;
        break;
      }
    }
    if (targetRowIndex === -1) return false;

    const colLetter = colNumToLetter(estadoIdx + 1);
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
