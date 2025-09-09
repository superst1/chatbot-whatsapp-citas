// api/webhook.js
import { handleMessage } from "../lib/gemini.js";
import {
  createAppointment,
  findAppointmentByCedula,
  updateAppointmentStatusByCedula
} from "../lib/sheets.js";
import { sendWhatsAppText } from "../lib/whatsapp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Estado en memoria (se reinicia al reiniciar el servidor)
const conversationState = {};

// ------------ Utilidades ------------

function parseManualData(text) {
  const data = {};

  // Cédula: 10 dígitos
  const cedulaMatch = text.match(/\b\d{10}\b/);
  if (cedulaMatch) data.numero_cedula = cedulaMatch[0];

  // Celular: 09 + 8 dígitos (Ecuador)
  const celularMatch = text.match(/\b09\d{8}\b/);
  if (celularMatch) data.celular_contacto = celularMatch[0];

  // Fecha dd/mm/yyyy o dd-mm-yyyy
  const fechaMatch = text.match(/\b\d{1,2}[\/-]\d{1,2}[\/-]\d{4}\b/);
  if (fechaMatch) data.fecha_cita = fechaMatch[0];

  // Nombre si viene con "nombre" o "paciente"
  const nombreMatch = text.match(
    /(?:nombre|paciente)\s+(?:es\s+)?([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+){0,3})/i
  );
  if (nombreMatch) data.nombre_paciente = nombreMatch[1].trim();

  return data;
}

function requiredMissing(data, fields) {
  return fields.filter((f) => !data[f] || String(data[f]).trim() === "");
}

function pickRandom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ------------ Handler ------------

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

  // Recepción de mensajes (POST)
  if (req.method === "POST") {
    try {
      const entry = req.body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // Filtrar notificaciones de estado
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

      // Variaciones de saludo/cierre
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

      // Instrucciones (actualizadas a consulta por cédula)
      const instrucciones = `Puedes decir:
- “crear cita para mañana 10am a nombre de Ana”
- “consultar cédula 1802525254”
- “actualizar 1802525254 a confirmada”`;

      let reply = "";

      // Si hay flujo pendiente y el intent actual NO es crear_cita, intentamos completar
      if (conversationState[from] && nlu.intent !== "crear_cita") {
        const prev = conversationState[from];
        const manualData = parseManualData(text);
        const combinedData = {
          ...prev.data,
          ...Object.fromEntries(Object.entries(nlu.data || {}).filter(([_, v]) => v)),
          ...manualData
        };

        const requiredFields = [
          "nombre_paciente",
          "numero_cedula",
          "nombre_contacto",
          "celular_contacto",
          "fecha_cita"
        ];
        const missing = requiredMissing(combinedData, requiredFields);

        if (missing.length === 0) {
          const numero_cita = await createAppointment({
            nombre_paciente: combinedData.nombre_paciente || profileName,
            numero_cedula: combinedData.numero_cedula || "",
            nombre_contacto: combinedData.nombre_contacto || profileName,
            celular_contacto: combinedData.celular_contacto || from,
            fecha_cita: combinedData.fecha_cita || "",
            status_cita: "pendiente",
            observaciones: combinedData.observaciones || ""
          });

          reply = `${pickRandom(saludos)} Tu cita ha sido registrada con la cédula ${combinedData.numero_cedula} y número interno ${numero_cita}. ${pickRandom(cierres)}`;
          delete conversationState[from];
        } else {
          conversationState[from] = { intent: "crear_cita", data: combinedData };
          reply = `Aún me falta: ${missing.join(", ")}.`;
        }

        await sendWhatsAppText(from, reply);
        return res.status(200).json({ received: true });
      }

      // Switch principal
      switch (nlu.intent) {
        case "crear_cita": {
          const manualData = parseManualData(text);
          const mergedData = { ...(nlu.data || {}), ...manualData };

          const requiredFields = [
            "nombre_paciente",
            "numero_cedula",
            "nombre_contacto",
            "celular_contacto",
            "fecha_cita"
          ];
          const missing = requiredMissing(mergedData, requiredFields);

          if (missing.length > 0) {
            conversationState[from] = { intent: "crear_cita", data: mergedData };
            reply = `📋 ${profileName}, para agendar necesito: ${missing.join(", ")}.`;
          } else {
            const numero_cita = await createAppointment({
              nombre_paciente: mergedData.nombre_paciente || profileName,
              numero_cedula: mergedData.numero_cedula || "",
              nombre_contacto: mergedData.nombre_contacto || profileName,
              celular_contacto: mergedData.celular_contacto || from,
              fecha_cita: mergedData.fecha_cita || "",
              status_cita: "pendiente",
              observaciones: mergedData.observaciones || ""
            });

            reply = `${pickRandom(saludos)} Tu cita ha sido registrada con la cédula ${mergedData.numero_cedula} y número interno ${numero_cita}. ${pickRandom(cierres)}`;
          }
          break;
        }

        case "consultar_cita": {
          // Ahora consultamos por cédula
          const cedula =
            nlu.data?.numero_cedula || parseManualData(text).numero_cedula || "";

          if (!cedula) {
            reply = `Por favor envíame la cédula para consultar la cita. Ej: consultar cédula 1802525254`;
            break;
          }

          // Requiere que en lib/sheets.js exista findAppointmentByCedula(cedula)
          const cita = await findAppointmentByCedula(cedula);

          reply = cita
            ? `📄 Cita de ${cita.nombre_paciente}:\n- Fecha: ${cita.fecha_cita}\n- Estado: ${cita.status_cita}\n- Obs: ${cita.observaciones || "N/A"}`
            : `⚠️ No encontré ninguna cita con la cédula ${cedula}.`;
          break;
        }

        case "actualizar_estado": {
          // Actualizamos por cédula
          const cedula =
            nlu.data?.numero_cedula || parseManualData(text).numero_cedula || "";
          const nuevo = nlu.data?.status_cita || "";

          if (!cedula || !nuevo) {
            reply = `Indica cédula y nuevo estado. Ej: actualizar 1802525254 a confirmada`;
            break;
          }

          // Requiere que en lib/sheets.js exista updateAppointmentStatusByCedula(cedula, estado)
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
