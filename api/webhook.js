// api/webhook.js
import { handleMessage } from "../lib/gemini.js";
import {
  createAppointment,
  findAppointmentByCedula,
  updateAppointmentStatusByCedula,
  isHoraDisponible,
  getHorasDisponibles
} from "../lib/sheets.js";
import { sendWhatsAppText } from "../lib/whatsapp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Estado de conversación y candado de slots en memoria
const conversationState = {};
const slotLocks = new Set();

/* ===================== Utilidades ===================== */

function parseManualData(text) {
  const data = {};

  // Cédula
  const cedulaMatch = text.match(/\b\d{10}\b/);
  if (cedulaMatch) data.numero_cedula = cedulaMatch[0];

  // Celular
  const celularMatch = text.match(/\b09\d{8}\b/);
  if (celularMatch) data.celular_contacto = celularMatch[0];

  // Fecha
  const fechaMatch = text.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/);
  if (fechaMatch) data.fecha_cita = normalizeFechaStr(fechaMatch[0]);

  // Hora
  const horaMatch24 = text.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  const horaMatchAmPm = text.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s?(am|pm)\b/i);
  if (horaMatch24) {
    data.hora_cita = normalizeHora(horaMatch24[0]);
  } else if (horaMatchAmPm) {
    const hh = parseInt(horaMatchAmPm[1], 10);
    const mm = horaMatchAmPm[2] || "00";
    const period = horaMatchAmPm[3].toLowerCase();
    data.hora_cita = to24Hour(hh, mm, period);
  }

  // Nombre etiquetado
  const nombreEtiquetado = text.match(
    /(?:nombre|paciente)\s+(?:es\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i
  );
  if (nombreEtiquetado) data.nombre_paciente = nombreEtiquetado[1].trim();

  // Nombre libre
  if (!data.nombre_paciente) {
    const nombreLibre = text.match(
      /\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)\b/
    );
    if (nombreLibre) data.nombre_paciente = nombreLibre[1].trim();
  }

  return data;
}

function normalizeHora(hhmm) {
  const [h, m] = hhmm.split(":");
  return `${String(parseInt(h, 10)).padStart(2, "0")}:${m}`;
}

function to24Hour(hh, mm, period) {
  let h = hh % 12;
  if (period === "pm") h += 12;
  return `${String(h).padStart(2, "0")}:${mm}`;
}

function normalizeFechaStr(fecha) {
  const partes = String(fecha).trim().split(/[\/-]/);
  if (partes.length >= 3) {
    const dd = partes[0].padStart(2, "0");
    const mm = partes[1].padStart(2, "0");
    const yyyy = partes[2].length === 2 ? `20${partes[2]}` : partes[2];
    return `${dd}/${mm}/${yyyy}`;
  }
  return String(fecha).trim();
}

function applyDefaults(from, profileName, data) {
  const d = { ...data };
  if (!d.nombre_contacto && d.nombre_paciente) d.nombre_contacto = d.nombre_paciente;
  if (!d.celular_contacto && from) d.celular_contacto = from;
  return d;
}

function requiredMissing(data, fields) {
  return fields.filter((f) => !data[f] || String(data[f]).trim() === "");
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

/* ===================== Handler ===================== */

export default async function handler(req, res) {
  // Verificación webhook
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // Recepción mensajes
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      if (value?.statuses) {
        return res.status(200).json({ received: true, statusUpdate: true });
      }

      const messages = value?.messages;
      if (!messages || messages.length === 0) {
        return res.status(200).json({ received: true, noMessage: true });
      }

      const msg = messages[0];
      const from = msg?.from;
      const text = msg?.text?.body || "";
      const profileName = value?.contacts?.[0]?.profile?.name || "Paciente";

      const nlu = await handleMessage(text);

      const saludos = [
        `Hola ${profileName} 👋`,
        `¡Qué gusto verte, ${profileName}!`,
        `Buenas, ${profileName} 😄`,
        `¡Hola de nuevo, ${profileName}!`
      ];
      const cierres = [
        "¡Te espero! 😊",
        "Nos vemos pronto.",
        "Gracias por confiar en nosotros.",
        "¡Hasta pronto!"
      ];
      const instrucciones = `Puedes decir:
- “crear cita para 10/10/2025 a las 10:00 a nombre de Ana”
- “consultar cédula 1802525254”
- “actualizar 1802525254 a confirmada”`;

      let reply = "";

      // === Flujo pendiente unificado ===
      if (conversationState[from]) {
        const prev = conversationState[from];
        const manualData = parseManualData(text);

        const combinedData = { ...prev.data };
        for (const [k, v] of Object.entries({ ...(nlu.data || {}), ...manualData })) {
          if (v && (!combinedData[k] || combinedData[k].trim() === "")) {
            combinedData[k] = v;
          }
        }
        const completedData = applyDefaults(from, profileName, combinedData);

        const requiredFields = ["nombre_paciente", "numero_cedula", "fecha_cita", "hora_cita"];
        const missing = requiredMissing(completedData, requiredFields);

        if (missing.length === 0) {
          const slotKey = `${completedData.fecha_cita}|${completedData.hora_cita}`;
          if (slotLocks.has(slotKey)) {
            const libres = await getHorasDisponibles(completedData.fecha_cita);
            reply = `⚠️ Ese horario está siendo reservado por otro usuario.\nHoras disponibles: ${libres.join(", ")}`;
          } else {
            slotLocks.add(slotKey);
            const disponible = await isHoraDisponible(completedData.fecha_cita, completedData.hora_cita);
            if (!disponible) {
              const libres = await getHorasDisponibles(completedData.fecha_cita);
              reply = `⚠️ La hora ${completedData.hora_cita} ya está ocupada el ${completedData.fecha_cita}.\nHoras disponibles: ${libres.join(", ")}`;
              conversationState[from] = { intent: "crear_cita", data: completedData };
            } else {
              const numero_cita = await createAppointment(completedData);
              reply = `${pickRandom(saludos)} Tu cita quedó registrada (cédula ${completedData.numero_cedula}) para el ${completedData.fecha_cita} a las ${completedData.hora_cita}. Número interno ${numero_cita}. ${pickRandom(cierres)}`;
              delete conversationState[from];
            }
            slotLocks.delete(slotKey);
          }
        } else {
          conversationState[from] = { intent: "crear_cita", data: completedData };
          reply = `📋 Me falta: ${missing.join(", ")}.`;
        }

       
