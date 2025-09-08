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
  "suggestion": string?
}

Reglas:
- Si el usuario quiere crear una cita pero faltan datos importantes, incluye los campos en "missing".
- En ese caso, genera una "suggestion" que sea un ejemplo de mensaje completo que el usuario podría enviar para crear la cita correctamente.
- Si todos los datos están presentes, "missing" debe ser una lista vacía y "suggestion" debe omitirse.
- Si no entiendes el mensaje, devuelve intent "otro".

Ejemplos:
- "crear cita para Juan Pérez mañana 10am, cédula 1234" → intent: "crear_cita", data con nombre, fecha, cédula, y missing vacío.
- "crear cita para Ana mañana" → intent: "crear_cita", data con nombre y fecha, missing: ["numero_cedula"], suggestion: "crear cita para Ana Pérez mañana a las 10am, cédula 123456789, celular 0991234567"
- "consultar 1023" → intent: "consultar_cita", data con numero_cita, missing vacío
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
      suggestion: parsed.suggestion || null
    };
  } catch (err) {
    console.error("Gemini parsing error:", err);
    return {
      intent: "otro",
      data: {},
      missing: [],
      suggestion: null
    };
  }
}
