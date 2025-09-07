import { google } from "googleapis";

const GOOGLE_SERVICE_ACCOUNT = process.env.GOOGLE_SERVICE_ACCOUNT; // JSON en Base64
const GOOGLE_SHEETS_SPREADSHEET_ID = "1AE5tWnRkiYXxCNMosBEt385frynPfHJT3NZ015T5TPA";
const GOOGLE_SHEETS_TAB_NAME = "CITAS";

const HEADERS = [
  "numero_cita",
  "nombre_paciente",
  "numero_cedula",
  "nombre_contacto",
  "celular_contacto",
  "fecha_cita",
  "status_cita",
  "observaciones"
];

function getAuth() {
  const json = JSON.parse(Buffer.from(GOOGLE_SERVICE_ACCOUNT, "base64").toString("utf-8"));
  return new google.auth.JWT(
    json.client_email,
    null,
    json.private_key,
    ["https://www.googleapis.com/auth/spreadsheets"]
  );
}

async function getSheets() {
  const auth = getAuth();
  return google.sheets({ version: "v4", auth });
}

async function ensureHeaders() {
  const sheets = await getSheets();
  const range = `${GOOGLE_SHEETS_TAB_NAME}!A1:H1`;
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    range
  });
  const current = res.data.values?.[0] || [];
  if (current.length === 0) {
    await sheets.spreadsheets.values.update({
      spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
      range,
      valueInputOption: "RAW",
      requestBody: { values: [HEADERS] }
    });
  }
}

async function getAllRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${GOOGLE_SHEETS_TAB_NAME}!A2:H`
  });
  const rows = res.data.values || [];
  return rows.map((r) => ({
    numero_cita: r[0],
    nombre_paciente: r[1],
    numero_cedula: r[2],
    nombre_contacto: r[3],
    celular_contacto: r[4],
    fecha_cita: r[5],
    status_cita: r[6],
    observaciones: r[7]
  }));
}

export async function createAppointment(data) {
  await ensureHeaders();
  const sheets = await getSheets();

  // ID simple basado en timestamp (6 dígitos finales)
  const numero_cita = `${Date.now().toString().slice(-6)}`;

  const row = [
    numero_cita,
    data.nombre_paciente || "",
    data.numero_cedula || "",
    data.nombre_contacto || "",
    data.celular_contacto || "",
    data.fecha_cita || "",
    data.status_cita || "pendiente",
    data.observaciones || ""
  ];

  await sheets.spreadsheets.values.append({
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    range: `${GOOGLE_SHEETS_TAB_NAME}!A:H`,
    valueInputOption: "RAW",
    requestBody: { values: [row] }
  });

  return numero_cita;
}

export async function findAppointmentById(numero_cita) {
  const all = await getAllRows();
  return all.find((x) => x.numero_cita === String(numero_cita));
}

export async function updateAppointmentStatus(numero_cita, nuevoEstado) {
  const sheets = await getSheets();
  const all = await getAllRows();
  const idx = all.findIndex((x) => x.numero_cita === String(numero_cita));
  if (idx === -1) return false;

  // Fila real = idx + 2 (encabezados en fila 1)
  const rowNumber = idx + 2;
  const range = `${GOOGLE_SHEETS_TAB_NAME}!G${rowNumber}`; // Columna G = status_cita
  await sheets.spreadsheets.values.update({
    spreadsheetId: GOOGLE_SHEETS_SPREADSHEET_ID,
    range,
    valueInputOption: "RAW",
    requestBody: { values: [[nuevoEstado]] }
  });
  return true;
}
