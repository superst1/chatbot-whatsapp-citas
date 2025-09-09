// lib/sheets.js
import { google } from "googleapis";

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const GOOGLE_SERVICE_ACCOUNT_EMAIL = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
const GOOGLE_PRIVATE_KEY = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

function getSheetsClient() {
  console.log("🔑 Inicializando cliente de Google Sheets...");
  const auth = new google.auth.JWT(
    GOOGLE_SERVICE_ACCOUNT_EMAIL,
    null,
    GOOGLE_PRIVATE_KEY,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
  return google.sheets({ version: "v4", auth });
}

export async function createAppointment(data) {
  console.log("📝 [createAppointment] Datos recibidos:", data);

  try {
    const sheets = getSheetsClient();

    // Prepara la fila a insertar
    const newRow = [
      data.nombre_paciente || "",
      data.numero_cedula || "",
      data.nombre_contacto || "",
      data.celular_contacto || "",
      data.fecha_cita || "",
      data.status_cita || "",
      data.observaciones || "",
      new Date().toISOString() // fecha de creación
    ];

    console.log("📤 [createAppointment] Fila a insertar:", newRow);

    const response = await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: "CITAS!A:H", // 🔹 Nombre exacto de la pestaña en mayúsculas
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: {
        values: [newRow]
      }
    });

    console.log("✅ [createAppointment] Respuesta de Google Sheets:", response.data);

    // Extraer número de cita desde el rango actualizado
    const updates = response.data.updates;
    const updatedRange = updates?.updatedRange || "";
    const match = updatedRange.match(/(\d+)$/);
    const numero_cita = match ? match[1] : null;

    console.log("🎯 [createAppointment] Número de cita asignado:", numero_cita);

    return numero_cita || "N/A";
  } catch (err) {
    console.error("💥 [createAppointment] Error al guardar en Google Sheets:", err);
    return null;
  }
}

export async function findAppointmentById(id) {
  console.log(`🔍 [findAppointmentById] Buscando cita con ID: ${id}`);

  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "CITAS!A:H" // 🔹 Nombre exacto de la pestaña
    });

    const rows = response.data.values || [];
    console.log(`📊 [findAppointmentById] Total filas encontradas: ${rows.length}`);

    const cita = rows.find(row => row[0] === id);
    console.log("📄 [findAppointmentById] Resultado:", cita);

    if (!cita) return null;

    return {
      numero_cita: cita[0],
      nombre_paciente: cita[1],
      numero_cedula: cita[2],
      nombre_contacto: cita[3],
      celular_contacto: cita[4],
      fecha_cita: cita[5],
      status_cita: cita[6],
      observaciones: cita[7]
    };
  } catch (err) {
    console.error("💥 [findAppointmentById] Error:", err);
    return null;
  }
}

export async function updateAppointmentStatus(id, nuevoEstado) {
  console.log(`♻️ [updateAppointmentStatus] Actualizando cita ${id} a estado: ${nuevoEstado}`);

  try {
    const sheets = getSheetsClient();
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: "CITAS!A:H" // 🔹 Nombre exacto de la pestaña
    });

    const rows = response.data.values || [];
    const rowIndex = rows.findIndex(row => row[0] === id);

    if (rowIndex === -1) {
      console.warn(`⚠️ [updateAppointmentStatus] No se encontró la cita ${id}`);
      return false;
    }

    const cell = `G${rowIndex + 1}`; // Ajusta la columna según tu hoja
    console.log(`✏️ [updateAppointmentStatus] Actualizando celda ${cell}`);

    await sheets.spreadsheets.values.update({
      spreadsheetId: SPREADSHEET_ID,
      range: cell,
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [[nuevoEstado]]
      }
    });

    console.log(`✅ [updateAppointmentStatus] Estado de la cita ${id} actualizado a: ${nuevoEstado}`);
    return true;
  } catch (err) {
    console.error("💥 [updateAppointmentStatus] Error:", err);
    return false;
  }
}
