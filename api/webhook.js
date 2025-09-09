import { sendWhatsAppText } from "../lib/whatsapp.js";
import {
  createAppointment,
  isHoraDisponible,
  getHorasDisponibles
} from "../lib/sheets.js";
import { procesarCitaConGemini } from "../lib/gemini.js";

const VERIFY_TOKEN = process.env.VERIFY_TOKEN;
const conversationState = {};
const slotLocks = new Set();

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

  if (req.method === "POST") {
    try {
      const msg = req.body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
      if (!msg) return res.status(200).json({ received: true });

      const from = msg.from;
      const text = msg.text?.body || "";
      const profileName =
        req.body?.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name ||
        "Paciente";

      // Estado actual de la conversación
      const currentState = conversationState[from]?.data || {};

      // Procesar con Gemini Flash 1.5
      const { datos, completo, respuesta } = await procesarCitaConGemini(
        currentState,
        text
      );

      if (completo) {
        // Validar disponibilidad
        const slotKey = `${datos.fecha_cita}|${datos.hora_cita}`;
        if (slotLocks.has(slotKey)) {
          const libres = await getHorasDisponibles(datos.fecha_cita);
          await sendWhatsAppText(
            from,
            `⚠️ Ese horario está siendo reservado por otro usuario.\nHoras disponibles: ${libres.join(", ")}`
          );
          conversationState[from] = { data: datos };
        } else {
          slotLocks.add(slotKey);
          const disponible = await isHoraDisponible(
            datos.fecha_cita,
            datos.hora_cita
          );
          if (!disponible) {
            const libres = await getHorasDisponibles(datos.fecha_cita);
            await sendWhatsAppText(
              from,
              `⚠️ La hora ${datos.hora_cita} ya está ocupada el ${datos.fecha_cita}.\nHoras disponibles: ${libres.join(", ")}\nDime cuál te conviene.`
            );
            conversationState[from] = { data: datos };
          } else {
            const numero_cita = await createAppointment(datos);
            await sendWhatsAppText(
              from,
              `✅ ${datos.nombre_paciente}, tu cita para el ${datos.fecha_cita} a las ${datos.hora_cita} ha sido registrada. Nº ${numero_cita}.`
            );
            delete conversationState[from];
          }
          slotLocks.delete(slotKey);
        }
      } else {
        // Falta información → guardar estado y responder
        conversationState[from] = { data: datos };
        await sendWhatsAppText(from, respuesta);
      }

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
