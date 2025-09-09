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

    console.log("🌐 Webhook verification request:", { mode, token });

    if (mode === "subscribe" && token === VERIFY_TOKEN) {
      console.log("✅ Webhook verificado correctamente");
      return res.status(200).send(challenge);
    } else {
      console.warn("❌ Falló la verificación del Webhook");
      return res.status(403).send("Verification failed");
    }
  }

  // 🔹 Recepción de mensajes (POST)
  if (req.method === "POST") {
    try {
      console.log("📩 Webhook POST recibido:", JSON.stringify(req.body, null, 2));

      const body = req.body;
      const entry = body?.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;

      // 📌 Filtrar notificaciones de estado
      if (value?.statuses) {
        console.log("📬 Notificación de estado recibida:", value.statuses);
        return res.status(200).json({ received: true, statusUpdate: true });
      }

      const messages = value?.messages;
      if (!messages || messages.length === 0) {
        console.log("⚠️ Webhook sin mensajes de usuario");
        return res.status(200).json({ received: true, noMessage: true });
      }

      const msg = messages[0];
      const from = msg?.from;
      const text = msg?.text?.body || "";
      const profileName = value?.contacts?.[0]?.profile?.name || "Paciente";

      console.log(`👤 Mensaje de ${profileName} (${from}): "${text}"`);

      // 🧠 NLU con Gemini
      const nlu = await handleMessage(text);
      console.log("🤖 Resultado NLU:", JSON.stringify(nlu, null, 2));

      let reply = "";

      // Si faltan datos para crear la cita
      if (nlu.intent === "crear_cita" && nlu.missing?.length > 0) {
        console.log("⚠️ Faltan datos para crear la cita:", nlu.missing);

        const opcionesFaltantes = [
          `📋 ${profileName}, para agendar necesito: ${nlu.missing.join(", ")}.`,
          `🤔 Me falta la siguiente información para tu cita: ${nlu.missing.join(", ")}.`,
          `📝 Antes de continuar, necesito que me indiques: ${nlu.missing.join(", ")}.`
        ];
        reply = opcionesFaltantes[Math.floor(Math.random() * opcionesFaltantes.length)];

        if (nlu.suggestion) {
          reply += `\nPuedes enviar algo como:\n💡 "${nlu.suggestion}"`;
        }

        console.log("📤 Enviando mensaje de solicitud de datos:", reply);
        await sendWhatsAppText(from, reply);
        return res.status(200).json({ received: true, missingData: true });
      }

      // 🔹 Procesamiento según intención
      switch (nlu.intent) {
        case "crear_cita": {
          console.log("🆕 Creando cita con datos:", nlu.data);

          const numero_cita = await createAppointment({
            nombre_paciente: nlu.data?.nombre_paciente || profileName,
            numero_cedula: nlu.data?.numero_cedula || "",
            nombre_contacto: nlu.data?.nombre_contacto || profileName,
            celular_contacto: nlu.data?.celular_contacto || from,
            fecha_cita: nlu.data?.fecha_cita || "",
            status_cita: "pendiente",
            observaciones: nlu.data?.observaciones || ""
          });

          console.log("✅ Resultado createAppointment:", numero_cita);

          // Usar humanMessage si existe, añadiendo número de cita
          if (nlu.humanMessage) {
            reply = `${nlu.humanMessage}\nNúmero de cita: ${numero_cita}`;
          } else {
            const opciones = [
              `✅ ${profileName}, tu cita quedó registrada con el número ${numero_cita}.`,
              `📅 Listo, agendé tu cita. Este es tu número: ${numero_cita}.`,
              `¡Hecho! Tu cita está confirmada con el número ${numero_cita}.`
            ];
            reply = opciones[Math.floor(Math.random() * opciones.length)];
          }
          break;
        }

        case "consultar_cita": {
          const id = nlu.data?.numero_cita || "";
          console.log("🔍 Consultando cita:", id);

          if (!id) {
            reply = `Por favor envíame el número de cita para consultarla. Ej: consultar 123456`;
            break;
          }
          const cita = await findAppointmentById(id);
          console.log("📄 Resultado consulta:", cita);

          reply = cita
            ? `📄 Cita ${id}:\n- Paciente: ${cita.nombre_paciente}\n- Fecha: ${cita.fecha_cita}\n- Estado: ${cita.status_cita}\n- Obs: ${cita.observaciones || "N/A"}`
            : `⚠️ No encontré la cita ${id}.`;
          break;
        }

        case "actualizar_estado": {
          const id = nlu.data?.numero_cita || "";
          const nuevo = nlu.data?.status_cita || "";
          console.log(`♻️ Actualizando cita ${id} a estado: ${nuevo}`);

          if (!id || !nuevo) {
            reply = `Indica número de cita y nuevo estado. Ej: actualizar 123456 a confirmada`;
            break;
          }
          const ok = await updateAppointmentStatus(id, nuevo);
          console.log("✅ Resultado actualización:", ok);

          reply = ok
            ? `✅ Estado de la cita ${id} actualizado a: ${nuevo}.`
            : `⚠️ No pude actualizar la cita ${id}. Verifica el número.`;
          break;
        }

        default: {
          console.log("ℹ️ Intent no reconocido, enviando mensaje por defecto");
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

      console.log("📤 Enviando respuesta final al usuario:", reply);
      await sendWhatsAppText(from, reply);
      return res.status(200).json({ received: true });

    } catch (err) {
      console.error("💥 Webhook error:", err);
      return res.status(500).json({ error: "Internal error" });
    }
  }

  // Otros métodos no permitidos
  console.warn("⚠️ Método HTTP no permitido:", req.method);
  return res.status(405).json({ error: "Method not allowed" });
}

export const config = {
  api: { bodyParser: { sizeLimit: "1mb" } }
};
