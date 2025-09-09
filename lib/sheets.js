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
  console.log("🔑 Inicializando cliente de Google Sheets con Base64...");
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
  s.toString()
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "_");

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
  const normalized = headers.map(h => normalize(h));
  console.log("🧭 Encabezados detectados:", headers);
  return { headers, normalized };
}

// Mapeo de tus campos lógicos a nombres de columna (normalizados) en la hoja
// Ajustado a la hoja que mostraste:
// A: nombre_dba           ← nombre_paciente
// B: nombre_gecahite      ← numero_cedula
// C: numero_cedula        ← nombre_contacto
// D: nombre_contacto      ← celular_contacto
// E: celular_contacto     ← fecha_cita
// F: fecha_dba            ← status_cita
// G: status_dba           ← observaciones
// H: observaciones        ← timestamp creación
const valueByHeader = (data) => ({
  nombre_dba: () => data.nombre_paciente || "",
  nombre_gecahite: () => data.numero_cedula || "",
  numero_cedula: () => data.nombre_contacto || "",
  nombre_contacto: () => data.celular_contacto || "",
  celular_contacto: () => data.fecha_cita || "",
  fecha_dba: () => data.status_cita || "",
  status_dba: () => data.observaciones || "",
  observaciones: () => new Date().toISOString(),

  // Sinónimos tolerantes (por si cambias cabeceras)
  nombre_paciente: () => data.nombre_paciente || "",
  cedula: () => data.numero_cedula || "",
  documento: () => data.numero_cedula || "",
  contacto: () => data.nombre_contacto || "",
  telefono: () => data.celular_contacto || "",
  celular: () => data.celular_contacto || "",
  fecha_cita: () => data.fecha_cita || "",
  estado: () => data.status_cita || "",
  notas: () => data.observaciones || "",
  observacion: () => data.observaciones || ""
});

export async function createAppointment(data) {
  console.log("📝 [createAppointment] Datos recibidos:", data);

  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);
    const mapping = valueByHeader(data);

    // Construir la fila respetando el orden real de las columnas
    const row = normalized.map(h => (mapping[h] ? mapping[h]() : ""));
    console.log("📤 [createAppointment] Fila calculada según encabezados:", row);

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A:Z`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values: [row] }
    });

    console.log("✅ [createAppointment] Respuesta de Google Sheets:", response.data);

    // Extraer número de fila insertada como "número de cita"
    const updatedRange = response.data?.updates?.updatedRange || "";
    const match = updatedRange.match(/!([A-Z]+)(\d+):/); // p.ej. CITAS!A5:H5
    const numero_cita = match ? match[2] : null;

    console.log("🎯 [createAppointment] Número de cita (fila):", numero_cita);
    return numero_cita || "N/A";
  } catch (err) {
    console.error("💥 [createAppointment] Error al guardar en Google Sheets:", err);
    return null;
  }
}

export async function findAppointmentById(id) {
  console.log(`🔍 [findAppointmentById] Buscando cita fila: ${id}`);

  try {
    const sheets = getSheetsClient();
    // Leer encabezados para poder devolver objeto con nombres lógicos
    const { headers, normalized } = await getHeaders(sheets);

    const resp = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET_TAB}!A${id}:Z${id}`
    });

    const row = (resp.data.values && resp.data.values[0]) || [];
    console.log("📄 [findAppointmentById] Fila leída:", row);

    // Reconstruir objeto con tus nombres lógicos (usando el mismo mapeo inverso)
    const obj = {};
    normalized.forEach((h, idx) => {
      const val = row[idx] ?? "";
      switch (h) {
        case "nombre_dba":
        case "nombre_paciente":
          obj.nombre_paciente = val;
          break;
        case "nombre_gecahite":
        case "cedula":
        case "documento":
          obj.numero_cedula = val;
          break;
        case "numero_cedula":
        case "contacto":
          obj.nombre_contacto = val;
          break;
        case "nombre_contacto":
        case "telefono":
        case "celular":
          obj.celular_contacto = val;
          break;
        case "celular_contacto":
        case "fecha_cita":
          obj.fecha_cita = val;
          break;
        case "fecha_dba":
        case "estado":
          obj.status_cita = val;
          break;
        case "status_dba":
        case "observacion":
        case "notas":
        case "observaciones":
          obj.observaciones = val;
          break;
        default:
          // ignorar otras columnas
          break;
      }
    });

    obj.numero_cita = id;
    return obj;
  } catch (err) {
    console.error("💥 [findAppointmentById] Error:", err);
    return null;
  }
}

export async function updateAppointmentStatus(id, nuevoEstado) {
  console.log(`♻️ [updateAppointmentStatus] Actualizando cita fila ${id} a estado: ${nuevoEstado}`);

  try {
    const sheets = getSheetsClient();
    const { headers, normalized } = await getHeaders(sheets);

    // Encontrar qué columna corresponde al "estado"
    const statusCandidates = [
      "fecha_dba",   // en tu hoja actual esta columna la usas para status_cita
      "estado",
      "status",
      "status_cita",
      "status_dba"
    ].map(normalize);

    let colIndex = -1;
    for (let i = 0; i < normalized.length; i++) {
      if (statusCandidates.includes(normalized[i])) {
        colIndex = i;
        break;
      }
    }

    if (colIndex === -1) {
      console.warn("⚠️ [updateAppointmentStatus] No se encontró columna de estado en encabezados:", headers);
      return false;
    }

    const colLetter = colNumToLetter(colIndex + 1); // 1-based
    const range = `${SHEET_TAB}!${colLetter}${id}`;
    console.log(`✏️ [updateAppointmentStatus] Actualizando rango ${range}`);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range,
      valueInputOption: "USER_ENTERED",
      requestBody: { values: [[nuevoEstado]] }
    });

    console.log(`✅ [updateAppointmentStatus] Estado actualizado en ${range} a: ${nuevoEstado}`);
    return true;
  } catch (err) {
    console.error("💥 [updateAppointmentStatus] Error:", err);
    return false;
  }
}
