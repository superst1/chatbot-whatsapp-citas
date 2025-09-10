import { google } from 'googleapis';

const SHEETS_ID = process.env.SHEETS_ID;
const SHEETS_TAB = process.env.SHEETS_TAB || 'Citas';

function getAuth() {
  // Permite GOOGLE_SA_JSON en base64 o JSON plano
  const raw = process.env.GOOGLE_SA_JSON;
  if (!raw) throw new Error('GOOGLE_SA_JSON faltante');
  const json = raw.trim().startsWith('{')
    ? JSON.parse(raw)
    : JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));

  const jwt = new google.auth.JWT(
    json.client_email,
    null,
    json.private_key,
    ['https://www.googleapis.com/auth/spreadsheets']
  );
  return jwt;
}

async function getSheets() {
  const auth = getAuth();
  await auth.authorize();
  return google.sheets({ version: 'v4', auth });
}

export async function getAllRows() {
  const sheets = await getSheets();
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEETS_ID,
    range: `${SHEETS_TAB}!A1:H`
  });
  const [header, ...rows] = res.data.values || [];
  return { header, rows };
}

export async function getBookedSlotsByDate(dateISO) {
  // Devuelve array de horas ISO ya ocupadas ese día (fecha_cita incluye fecha y hora)
  const { header, rows } = await getAllRows();
  if (!header) return [];
  const idxFecha = header.indexOf('fecha_cita');
  const idxStatus = header.indexOf('status_cita');

  const day = dateISO.slice(0, 10); // YYYY-MM-DD
  const booked = [];
  for (const r of rows) {
    const f = r[idxFecha];
    const s = (r[idxStatus] || '').toLowerCase();
    if (!f) continue;
    // Solo cuenta agendada y re agendado como ocupadas
    if (s === 'agendada' || s === 're agendado' || s === 'reagendado') {
      // Normaliza a ISO
      const iso = toISO(f);
      if (iso && iso.startsWith(day)) booked.push(iso);
    }
  }
  return booked;
}

export async function appendAppointment(rowObj) {
  // rowObj con llaves exactas del header
  const sheets = await getSheets();
  const { header } = await getAllRows();
  const ordered = header.map(h => rowObj[h] ?? '');
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEETS_ID,
    range: SHEETS_TAB,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [ordered] }
  });
}

export async function updateAppointmentByNumero(numero_cita, patch) {
  // Busca la fila por numero_cita y actualiza columnas dadas
  const sheets = await getSheets();
  const { header, rows } = await getAllRows();
  const idxNumero = header.indexOf('numero_cita');

  const rowIndex = rows.findIndex(r => (r[idxNumero] || '').toString() === numero_cita.toString());
  if (rowIndex === -1) return false;

  // Construye la fila final fusionando patch con la fila existente
  const existing = rows[rowIndex];
  const updated = [...existing];

  for (const [k, v] of Object.entries(patch)) {
    const idx = header.indexOf(k);
    if (idx !== -1) updated[idx] = v ?? '';
  }

  // A1 notation row number = header row (1) + rowIndex + 1
  const range = `${SHEETS_TAB}!A${rowIndex + 2}:H${rowIndex + 2}`;
  await sheets.spreadsheets.values.update({
    spreadsheetId: SHEETS_ID,
    range,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [updated] }
  });
  return true;
}

export function toISO(input) {
  // Acepta formatos tipo "10/09/2025 15:00" o ISO, devuelve ISO "YYYY-MM-DDTHH:mm"
  // Heurística simple (dd/mm/yyyy hh:mm)
  if (!input) return null;
  const s = input.toString().trim();
  if (s.includes('T')) {
    // Ya es ISO razonable
    return s.length >= 16 ? s.slice(0, 16) : null;
  }
  const match = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (match) {
    const dd = match[1].padStart(2, '0');
    const mm = match[2].padStart(2, '0');
    const yyyy = match[3];
    const hh = (match[4] ?? '09').padStart(2, '0');
    const min = (match[5] ?? '00').padStart(2, '0');
    return `${yyyy}-${mm}-${dd}T${hh}:${min}`;
  }
  // Intenta fecha sola "10/09/2025"
  const onlyDate = s.match(/(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})/);
  if (onlyDate) {
    const dd = onlyDate[1].padStart(2, '0');
    const mm = onlyDate[2].padStart(2, '0');
    const yyyy = onlyDate[3];
    return `${yyyy}-${mm}-${dd}T00:00`;
  }
  return null;
}
