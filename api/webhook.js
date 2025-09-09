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

// Estados en memoria
const conversationState = {};
const slotLocks = new Set();

/* ===================== Utilidades ===================== */

function parseManualData(text) {
  const data = {};
  const t = (text || "").trim();

  // Cédula: 10 dígitos
  const cedulaMatch = t.match(/\b\d{10}\b/);
  if (cedulaMatch) data.numero_cedula = cedulaMatch[0];

  // Celular: 09 + 8 dígitos
  const celularMatch = t.match(/\b09\d{8}\b/);
  if (celularMatch) data.celular_contacto = celularMatch[0];

  // Fecha: dd/mm/yyyy o dd-mm-yyyy
  const fechaMatch = t.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{2,4}\b/);
  if (fechaMatch) data.fecha_cita = normalizeFechaStr(fechaMatch[0]);

  // Hora: HH:mm (24h) o 12h con am/pm -> normalizada a HH:mm
  const horaMatch24 = t.match(/\b([01]?\d|2[0-3]):[0-5]\d\b/);
  const horaMatchAmPm = t.match(/\b(1[0-2]|0?\d)(?::([0-5]\d))?\s?(am|pm)\b/i);
  if (horaMatch24) {
    data.hora_cita = normalizeHora(horaMatch24[0]);
  } else if (horaMatchAmPm) {
    const hh = parseInt(horaMatchAmPm[1], 10);
    const mm = horaMatchAmPm[2] || "00";
    const period = horaMatchAmPm[3].toLowerCase();
    data.hora_cita = to24Hour(hh, mm, period);
  }

  // Nombre etiquetado
  const nombreEtiquetado = t.match(
    /(?:nombre|paciente)\s+(?:es\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i
  );
  if (nombreEtiquetado) data.nombre_paciente = nombreEtiquetado[1].trim();

  // Nombre libre: dos+ palabras con mayúscula inicial
  if (!data.nombre_paciente) {
    const nombreLibre = t.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)\b/);
    if (nombreLibre) data.nombre_paciente = nombreLibre[1].trim();
  }

  return data;
}

function normalizeHora(hhmm) {
  const [h, m] = String(hhmm).split(":");
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
  // Verificación (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    }
    return res.status(403).send("Verification failed");
  }

  // Recepción (POST)
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // Estados de WhatsApp
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

      // NLU
      const nlu = await handleMessage(text);

      // Estilo
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

      // === Flujo pendiente unificado (siempre antes del switch) ===
      if (conversationState[from]) {
        const prev = conversationState[from];

        // Parseo manual
        const manualData = parseManualData(text);

        // Si el usuario envía solo una hora, tomarla directo (permite "14:00" o "14:00 por favor")
        const soloHora = text.trim().match(/^([01]?\d|2[0-3]):[0-5]\d(?:\s*(?:am|pm))?(?:\s+por\s+favor)?$/i);
        if (soloHora) {
          manualData.hora_cita = normalizeHora(soloHora[0]);
        }

        // Merge inteligente: no pisar campos existentes
        const combinedData = { ...prev.data };
        for (const [k, v] of Object.entries({ ...(nlu.data || {}), ...manualData })) {
          if (v && (!combinedData[k] || String(combinedData[k]).trim() === "")) {
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
            reply = `⚠️ Ese horario está siendo reservado por otro usuario.\nHoras disponibles: ${libres.join(", ")}\nDime cuál eliges.`;
            conversationState[from] = { intent: "crear_cita", data: completedData };
          } else {
            slotLocks.add(slotKey);
            const disponible = await isHoraDisponible(completedData.fecha_cita, completedData.hora_cita);
            if (!disponible) {
              const libres = await getHorasDisponibles(completedData.fecha_cita);
              reply = `⚠️ La hora ${completedData.hora_cita} ya está ocupada el ${completedData.fecha_cita}.\nHoras disponibles: ${libres.join(", ")}\nDime cuál te conviene.`;
              conversationState[from] = { intent: "crear_cita", data: completedData };
            } else {
              const numero_cita = await createAppointment(completedData);
              reply = `${pickRandom(saludos)} Tu cita quedó registrada (cédula ${completedData.numero_cedula}) para el ${completedData.fecha_cita} a las ${completedData.hora_cita}. Número interno ${numero_cita}. ${pickRandom(cierres)}`;
              delete conversationState[from];
            }
            slotLocks.delete(slotKey);
          }

          await sendWhatsAppText(from, reply);
          return res.status(200).json({ received: true });
        } else {
          conversationState[from] = { intent: "crear_cita", data: completedData };
          reply = `📋 Me falta: ${missing.join(", ")}.`;
          await sendWhatsAppText(from, reply);
          return res.status(200).json({ received: true });
        }
      }

      // === Switch principal (cuando no hay flujo pendiente) ===
      switch (nlu.intent) {
        case "crear_cita": {
          const manualData = parseManualData(text);
          const base = { ...(nlu.data || {}), ...manualData };
          const mergedData = applyDefaults(from, profileName, base);

          const requiredFields = ["nombre_paciente", "numero_cedula", "fecha_cita", "hora_cita"];
          const missing = requiredMissing(mergedData, requiredFields);

          if (missing.length > 0) {
            conversationState[from] = { intent: "crear_cita", data: mergedData };
            reply = `📋 ${profileName}, para agendar necesito: ${missing.join(", ")}.`;
          } else {
            const slotKey = `${mergedData.fecha_cita}|${mergedData.hora_cita}`;
            if (slotLocks.has(slotKey)) {
              const libres = await getHorasDisponibles(mergedData.fecha_cita);
              reply = `⚠️ Ese horario está siendo reservado por otro usuario.\nHoras disponibles: ${libres.join(", ")}\nDime cuál eliges.`;
              conversationState[from] = { intent: "crear_cita", data: mergedData };
            } else {
              slotLocks.add(slotKey);
              const disponible = await isHoraDisponible(mergedData.fecha_cita, mergedData.hora_cita);
              if (!disponible) {
                const libres = await getHorasDisponibles(mergedData.fecha_cita);
                reply = `⚠️ La hora ${mergedData.hora_cita} ya está ocupada el ${mergedData.fecha_cita}.\nHoras disponibles: ${libres.join(", ")}\nDime cuál te conviene.`;
                conversationState[from] = { intent: "crear_cita", data: mergedData };
              } else {
                const numero_cita = await createAppointment(mergedData);
                reply = `${pickRandom(saludos)} Tu cita quedó registrada (cédula ${mergedData.numero_cedula}) para el ${mergedData.fecha_cita} a las ${mergedData.hora_cita}. Número interno ${numero_cita}. ${pickRandom(cierres)}`;
              }
              slotLocks.delete(slotKey);
            }
          }
          break;
        }

        case "consultar_cita": {
          const cedula = nlu.data?.numero_cedula || parseManualData(text).numero_cedula || "";
          if (!cedula) {
            reply = `Por favor envíame la cédula para consultar la cita. Ej: consultar cédula 1802525254`;
            break;
          }
          const cita = await findAppointmentByCedula(cedula);
          reply = cita
            ? `📄 Cita de ${cita.nombre_paciente || ""}\n- Fecha: ${cita.fecha_cita || ""}\n- Hora: ${cita.hora_cita || ""}\n- Estado: ${cita.status_cita || ""}\n- Obs: ${cita.observaciones || "N/A"}`
            : `⚠️ No encontré ninguna cita con la cédula ${cedula}.`;
          break;
        }

        case "actualizar_estado": {
          const cedula = nlu.data?.numero_cedula || parseManualData(text).numero_cedula || "";
          const nuevo = nlu.data?.status_cita || "";
          if (!cedula || !nuevo) {
            reply = `Indica cédula y nuevo estado. Ej: actualizar 1802525254 a confirmada`;
            break;
          }
          const ok = await updateAppointmentStatusByCedula(cedula, nuevo);
          reply = ok
            ? `✅ Estado de la cita con cédula ${cedula} actualizado a: ${nuevo}.`
            : `⚠️ No pude actualizar la cita con cédula ${cedula}. Verifica si existe.`;
          break;
        }

        default: {
          const ayudas = [
            `Puedo ayudarte a crear, consultar o actualizar tus citas.`,
            `Gestiono tus citas médicas de forma rápida y sencilla.`,
            `Estoy aquí para agendar, consultar o modificar tus citas.`
          ];
          reply = `${pickRandom(saludos)} ${pickRandom(ayudas)}
${instrucciones}`;
        }
      }

      await sendWhatsAppText(from, reply);
      return res.status(200).json({ received: true });
    } catch (err) {
      console.error("💥 Webhook error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // Otros métodos
  return res.status(405).json({ error: "Method not allowed" });
}

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};
