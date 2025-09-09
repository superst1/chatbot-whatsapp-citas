// lib/sheets.js
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_TAB = process.env.SHEET_TAB || "CITAS";

/* Auth */
let credentials = {};
try {
  const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS_BASE64, "base64").toString("utf8");
  credentials = JSON.parse(decoded || "{}");
} catch (e) {
  console.error("GOOGLE_CREDENTIALS_BASE64 inválido:", e);
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

/* Utils */
const normalize = (s = "") =>
  s.toString().trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, "_");

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
  const p = String(fecha).trim().split(/[\/-]/);
  if (p.length >= 3) {
    const dd = p[0].padStart(2, "0");
    const mm = p[1].padStart(2, "0");
    const yyyy = p[2].length === 2 ? `20${p[2]}` : p[2];
    return `${dd}/${mm}/${yyyy}`;
  }
  return String(fecha).trim();
}

function normalizarHora(hora) {
  if (!hora) return "";
  const t = String(hora).trim();
  const ampm = t.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s?(am|pm)\b/i);
  if (ampm) {
    let hh = parseInt(ampm[1], 10) % 12;
    if (ampm[3].toLowerCase() === "pm") hh += 12;
    const mm = ampm[2] || "00";
    return `${String(hh).padStart(2, "0")}:${mm}`;
  }
  const hhmm = t.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) return `${String(parseInt(hhmm[1], 10)).padStart(2, "0")}:${hhmm[2]}`;
  return t;
}

/* Crear */
export async function createAppointment(data) {
  try {
    const sheets = getSheetsClient();
    const head = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!1:1`
    });
    const headers = head.data.values?.[0] || [];
    const normalized = headers.map(normalize);

    const row = normalized.map((h) => {
      switch (h) {
        case "nombre_paciente": return data.nombre_paciente || "";
        case "numero_cedula": return data.numero_cedula || "";
        case "nombre_contacto": return data.nombre_contacto || "";
        case "celular_contacto": return data.celular_contacto || "";
        case "fecha_cita":
        case "fecha": return normalizarFecha(data.fecha_cita);
        case "hora_cita":
        case "hora": return normalizarHora(data.hora_cita);
        case "status_cita":
        case "estado": return data.status_cita || "pendiente";
        default: return "";
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

/* Disponibilidad */
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

    for (let i = 1; i < rows.length; i++) {
      if (
        normalizarFecha(rows[i][fechaIdx]) === fechaNorm &&
        normalizarHora(rows[i][horaIdx]) === horaNorm
      ) return false;
    }
    return true;
  } catch (err) {
    console.error("[isHoraDisponible] Error:", err);
    return true;
  }
}

export async function getHorasDisponibles(fecha) {
  try {
    const fechaNorm = normalizarFecha(fecha);
    const base = [];
    for (let h = 8; h <= 17; h++) base.push(`${String(h).padStart(2, "0")}:00`);

    const sheets = getSheetsClient();
    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`
    });
    const rows = resp.data.values || [];
    if (rows.length <= 1) return base;

    const headers = rows[0];
    const normalized = headers.map(normalize);
    const fechaIdx = getColIndex(normalized, ["fecha_cita", "fecha"]);
    const horaIdx = getColIndex(normalized, ["hora_cita", "hora"]);
    if (fechaIdx === -1 || horaIdx === -1) return base;

    const ocupadas = new Set(
      rows
        .slice(1)
        .filter((r) => normalizarFecha(r[fechaIdx]) === fechaNorm)
        .map((r) => normalizarHora(r[horaIdx]))
    );

    return base.filter((h) => !ocupadas.has(h));
  } catch (err) {
    console.error("[getHorasDisponibles] Error:", err);
    return [];
  }
}

/* Re-agendar */
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

    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return false;

    for (const [campo, valorBruto] of Object.entries(nuevosDatos)) {
      const colIdx = getColIndex(normalized, [campo]);
      if (colIdx === -1) continue;
      const val = campo.toLowerCase().includes("fecha")
        ? normalizarFecha(valorBruto)
        : campo.toLowerCase().includes("hora")
        ? normalizarHora(valorBruto)
        : valorBruto;
      if (val === undefined || val === null || String(val).trim() === "") continue;

      const colLetter = colNumToLetter(colIdx + 1);
      const range = `${SHEET_TAB}!${colLetter}${rowIndex + 1}`;
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range,
        valueInputOption: "USER_ENTERED",
        requestBody: { values: [[val]] }
      });
    }
    return true;
  } catch (err) {
    console.error("[updateAppointmentByCedula] Error:", err);
    return false;
  }
}

/* Cancelar / cambiar estado */
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

    let rowIndex = -1;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) { rowIndex = i; break; }
    }
    if (rowIndex === -1) return false;

    const colLetter = colNumToLetter(estadoIdx + 1);
    const range = `${SHEET_TAB}!${colLetter}${rowIndex + 1}`;
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
