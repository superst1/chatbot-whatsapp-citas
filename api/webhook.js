// api/webhook.js
import { handleMessage } from "../lib/gemini.js";
import { createAppointment, findAppointmentById, updateAppointmentStatus } from "../lib/sheets.js";
import { sendWhatsAppText } from "../lib/whatsapp.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;

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
      const messages = value?.messages;

      if (!messages || messages.length === 0) {
        return res.status(200).json({ received: true, noMessage: true });
      }

      const msg = messages[0];
      const from = msg?.from; // número del usuario
      const text = msg?.text?.body || "";
      const profileName = value?.contacts?.[0]?.profile?.name || "Paciente";

      // 🧠 NLU con Gemini (puedes enriquecer el prompt en handleMessage)
      const nlu = await handleMessage(text);

      let reply = "";

      // Si falta información para crear la cita
      if (nlu.intent === "crear_cita" && nlu.missing?.length > 0) {
        const opcionesFaltantes = [
          `📋 ${profileName}, para agendar necesito: ${nlu.missing.join(", ")}.`,
          `🤔 Me falta la siguiente información para tu cita: ${nlu.missing.join(", ")}.`,
          `📝 Antes de continuar, necesito que me indiques: ${nlu.missing.join(", ")}.`
        ];
        reply = opcionesFaltantes[Math.floor(Math.random() * opcionesFaltantes.length)];

        if (nlu.suggestion) {
          reply += `\nPuedes enviar algo como:\n💡 "${nlu.suggestion}"`;
        }

        await sendWhatsAppText(from, reply);
        return res.status(200).json({ received: true, missingData: true });
      }

      // 🔹 Procesamiento según intención
      switch (nlu.intent) {
        case "crear_cita": {
          const numero_cita = await createAppointment({
            nombre_paciente: nlu.data?.nombre_paciente || profileName,
            numero_cedula: nlu.data?.numero_cedula || "",
            nombre_contacto: nlu.data?.nombre_contacto || profileName,
            celular_contacto: nlu.data?.celular_contacto || from,
            fecha_cita: nlu.data?.fecha_cita || "",
            status_cita: "pendiente",
            observaciones: nlu.data?.observaciones || ""
          });

          const opciones = [
            `✅ ${profileName}, tu cita quedó registrada con el número ${numero_cita}.`,
            `📅 Listo, agendé tu cita. Este es tu número: ${numero_cita}.`,
            `¡Hecho! Tu cita está confirmada con el número ${numero_cita}.`
          ];
          reply = opciones[Math.floor(Math.random() * opciones.length)];
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
          const saludos = [
            `Hola ${profileName} 👋 Soy MedicAsist, tu asistente de citas.`,
            `¡Encantado de ayudarte, ${profileName}! Soy MedicAsist.`,
            `Hola ${profileName} 😊, aquí para ayudarte con tus citas.`
          ];
          const instrucciones = `Puedes decir:
- “crear cita para mañana 10am a nombre de Ana”
- “consultar 123456”
- “actualizar 123456 a confirmada”`;

          reply = `${saludos[Math.floor(Math.random() * saludos.length)]}\n${instrucciones}`;
        }
      }

      await sendWhatsAppText(from, reply);
      return res.status(200).json({ received: true });

    } catch (err) {
      console.error("Webhook error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // Otros métodos no permitidos
  return res.status(405).json({ error: "Method not allowed" });
}

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};
