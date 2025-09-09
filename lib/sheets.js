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

// Crear cita
export async function createAppointment(data) {
  try {
    const sheets = getSheetsClient();
    const respHeaders = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!1:1`
    });
    const headers = (respHeaders.data.values && respHeaders.data.values[0]) || [];
    const normalized = headers.map(normalize);

    const mapping = {
      nombre_dba: data.nombre_paciente || "",
      nombre_gecahite: data.numero_cedula || "",
      numero_cedula: data.nombre_contacto || "",
      nombre_contacto: data.celular_contacto || "",
      celular_contacto: data.fecha_cita || "",
      fecha_dba: data.status_cita || "",
      status_dba: data.observaciones || "",
      observaciones: new Date().toISOString()
    };

    const row = normalized.map((h) => mapping[h] ?? "");
    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });

    const updatedRange = response.data?.updates?.updatedRange || "";
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
    const headersResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!1:1`
    });
    const headers = (headersResp.data.values && headersResp.data.values[0]) || [];
    const normalized = headers.map(normalize);

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

    let foundRow = null;
    for (let i = 1; i < rows.length; i++) {
      if ((rows[i][cedulaIdx] || "").toString() === cedula) {
        foundRow = rows[i];
        break;
      }
    }
    if (!foundRow) return null;

    return {
      nombre_paciente: foundRow[0],
      numero_cedula: foundRow[1],
      nombre_contacto: foundRow[2],
      celular_contacto: foundRow[3],
      fecha_cita: foundRow[4],
      status_cita: foundRow[5],
      observaciones: foundRow[6]
    };
  } catch (err) {
    console.error("💥 [findAppointmentByCedula] Error:", err);
    return null;
  }
}

// Actualizar estado por cédula
export async function updateAppointmentStatusByCedula(cedula, nuevoEstado) {
  try {
    const sheets = getSheetsClient();
    const headersResp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!1:1`
    });
    const headers = (headersResp.data.values && headersResp.data.values[0]) || [];
    const normalized = headers.map(normalize);

    const cedulaIdx = normalized.findIndex((h) =>
      ["numero_cedula", "cedula", "documento", "nombre_gecahite"].includes(h)
    );
    const statusIdx = normalized.findIndex((h) =>
      ["status_cita", "estado", "status", "status_dba", "fecha_dba"].includes(h)
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
