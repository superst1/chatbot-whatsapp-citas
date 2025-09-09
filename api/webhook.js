// api/webhook.js
import { handleMessage } from "../lib/gemini.js";
import { createAppointment, findAppointmentById, updateAppointmentStatus } from "../lib/sheets.js";
import { sendWhatsAppText } from "../lib/whatsapp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

// Estado en memoria (se reinicia si se reinicia el servidor)
const conversationState = {};

export default async function handler(req, res) {
  // 🔹 Verificación de Webhook (GET)
  if (req.method === "GET") {
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      return res.status(200).send(challenge);
    } else {
      return res.status(403).send("Verification failed");
    }
  }

  // 🔹 Recepción de mensajes (POST)
  if (req.method === "POST") {
    try {
      const body = req.body;
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // 📌 Filtrar notificaciones de estado
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

      // 🧠 NLU con Gemini
      const nlu = await handleMessage(text);

      let reply = "";

      // 🎨 Variaciones de saludo y cierre
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

      // 📌 Manejo de estado: si hay un flujo pendiente
      if (conversationState[from] && nlu.intent !== "crear_cita") {
        const prev = conversationState[from];
        // Combinar datos nuevos con los anteriores
        const combinedData = { ...prev.data, ...nlu.data };

        // Verificar si ya tenemos todos los campos requeridos
        const requiredFields = ["nombre_paciente", "numero_cedula", "nombre_contacto", "celular_contacto", "fecha_cita"];
        const missing = requiredFields.filter(f => !combinedData[f] || combinedData[f].trim() === "");

        if (missing.length === 0) {
          // Crear la cita
          const numero_cita = await createAppointment({
            nombre_paciente: combinedData.nombre_paciente || profileName,
            numero_cedula: combinedData.numero_cedula || "",
            nombre_contacto: combinedData.nombre_contacto || profileName,
            celular_contacto: combinedData.celular_contacto || from,
            fecha_cita: combinedData.fecha_cita || "",
            status_cita: "pendiente",
            observaciones: combinedData.observaciones || ""
          });

          const saludo = saludos[Math.floor(Math.random() * saludos.length)];
          const cierre = cierres[Math.floor(Math.random() * cierres.length)];
          reply = `${saludo} Tu cita ha sido registrada con el número ${numero_cita}. ${cierre}`;

          // Limpiar estado
          delete conversationState[from];
        } else {
          // Actualizar estado y pedir lo que falta
          conversationState[from] = { intent: "crear_cita", data: combinedData };
          reply = `Aún me falta: ${missing.join(", ")}.`;
        }

        await sendWhatsAppText(from, reply);
        return res.status(200).json({ received: true });
      }

      // 🔹 Procesamiento según intención
      switch (nlu.intent) {
        case "crear_cita": {
          if (nlu.missing?.length > 0) {
            // Guardar estado pendiente
            conversationState[from] = { intent: "crear_cita", data: nlu.data };
            reply = `📋 ${profileName}, para agendar necesito: ${nlu.missing.join(", ")}.`;
          } else {
            const numero_cita = await createAppointment({
              nombre_paciente: nlu.data?.nombre_paciente || profileName,
              numero_cedula: nlu.data?.numero_cedula || "",
              nombre_contacto: nlu.data?.nombre_contacto || profileName,
              celular_contacto: nlu.data?.celular_contacto || from,
              fecha_cita: nlu.data?.fecha_cita || "",
              status_cita: "pendiente",
              observaciones: nlu.data?.observaciones || ""
            });

            const saludo = saludos[Math.floor(Math.random() * saludos.length)];
            const cierre = cierres[Math.floor(Math.random() * cierres.length)];
            reply = `${saludo} Tu cita ha sido registrada con el número ${numero_cita}. ${cierre}`;
          }
          break;
        }

        case "consultar_cita": {
          const id = nlu.data?.numero_cita || "";
          if (!id) {
            reply = `Por favor envíame el número de cita para consultarla. Ej: consultar 123456`;
            break;
          }
          const cita = await findAppointmentById(id);
          reply = cita
            ? `📄 Cita ${id}:\n- Paciente: ${cita.nombre_paciente}\n- Fecha: ${cita.fecha_cita}\n- Estado: ${cita.status_cita}\n- Obs: ${cita.observaciones || "N/A"}`
            : `⚠️ No encontré la cita ${id}.`;
          break;
        }

        case "actualizar_estado": {
          const id = nlu.data?.numero_cita || "";
          const nuevo = nlu.data?.status_cita || "";
          if (!id || !nuevo) {
            reply = `Indica número de cita y nuevo estado. Ej: actualizar 123456 a confirmada`;
            break;
          }
          const ok = await updateAppointmentStatus(id, nuevo);
          reply = ok
            ? `✅ Estado de la cita ${id} actualizado a: ${nuevo}.`
            : `⚠️ No pude actualizar la cita ${id}. Verifica el número.`;
          break;
        }

        default: {
          const ayudas = [
            `Puedo ayudarte a crear, consultar o actualizar tus citas.`,
            `Gestiono tus citas médicas de forma rápida y sencilla.`,
            `Estoy aquí para agendar, consultar o modificar tus citas.`
          ];
          const instrucciones = `Puedes decir:
- “crear cita para mañana 10am a nombre de Ana”
- “consultar 123456”
- “actualizar 123456 a confirmada”`;

          const saludo = saludos[Math.floor(Math.random() * saludos.length)];
          reply = `${saludo} ${ayudas[Math.floor(Math.random() * ayudas.length)]}\n${instrucciones}`;
        }
      }

      await sendWhatsAppText(from, reply);
      return res.status(200).json({ received: true });

    } catch (err) {
      console.error("💥 Webhook error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  return res.status(405).json({ error: "Method not allowed" });
}

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};
