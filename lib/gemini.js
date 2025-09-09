const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";

export async function handleMessage(userText) {
  const systemPrompt = `
Eres un parser NLU para citas médicas. Tu tarea es interpretar el mensaje del usuario y devolver SOLO JSON válido con:

{
  "intent": "crear_cita|consultar_cita|actualizar_estado|otro",
  "data": {
    "numero_cita": string?,
    "nombre_paciente": string?,
    "numero_cedula": string?,
    "nombre_contacto": string?,
    "celular_contacto": string?,
    "fecha_cita": string?,
    "status_cita": string?,
    "observaciones": string?
  },
  "missing": [campos_faltantes],
  "suggestion": string?,
  "humanMessage": string
}

Reglas:
- "humanMessage" debe ser un mensaje breve, cálido y natural que puedas enviar directamente al usuario en WhatsApp, usando un tono amable y cercano.
- Si el usuario quiere crear una cita pero faltan datos importantes, incluye los campos en "missing" y en "humanMessage" explícalo de forma cordial, invitando a completarlos.
- Si todos los datos están presentes, "missing" debe ser una lista vacía.
- Si no entiendes el mensaje, devuelve intent "otro" y un "humanMessage" que invite al usuario a reformular.
- Usa emojis de forma moderada para dar calidez.
- No incluyas texto fuera del JSON.

Ejemplos:
Usuario: "crear cita para Juan Pérez mañana 10am, cédula 1234"
→ intent: "crear_cita", missing: [], humanMessage: "✅ Juan Pérez, tu cita para mañana a las 10am ha sido registrada."

Usuario: "crear cita para Ana mañana"
→ intent: "crear_cita", missing: ["numero_cedula"], suggestion: "crear cita para Ana Pérez mañana a las 10am, cédula 123456789, celular 0991234567", humanMessage: "📋 Ana, para agendar tu cita necesito tu número de cédula."

Usuario: "consultar 1023"
→ intent: "consultar_cita", missing: [], humanMessage: "🔍 Consultando la cita 1023..."
`;

  const body = {
    contents: [
      {
        role: "user",
        parts: [{ text: systemPrompt + "\nUsuario: " + userText }]
      }
    ]
  };

  try {
    const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });

    const data = await resp.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1));

    return {
      intent: parsed.intent || "otro",
      data: parsed.data || {},
      missing: parsed.missing || [],
      suggestion: parsed.suggestion || null,
      humanMessage: parsed.humanMessage || null
    };
  } catch (err) {
    console.error("Gemini parsing error:", err);
    return {
      intent: "otro",
      data: {},
      missing: [],
      suggestion: null,
      humanMessage: null
    };
  }
}
