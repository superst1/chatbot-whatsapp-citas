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
 "missing": [campos_faltantes]
}

Reglas:
- Si el usuario quiere crear una cita pero no proporciona número de cédula, inclúyelo en "missing".
- Si faltan otros datos importantes como fecha, nombre o celular, también inclúyelos en "missing".
- Si todos los datos están presentes, "missing" debe ser una lista vacía.
- Si no entiendes el mensaje, devuelve intent "otro".

Ejemplos:
- "crear cita para Juan Pérez mañana 10am, cédula 1234" → intent: "crear_cita", data con nombre, fecha, cédula, y missing vacío.
- "crear cita para Ana mañana" → intent: "crear_cita", data con nombre y fecha, missing: ["numero_cedula"]
- "consultar 1023" → intent: "consultar_cita", data con numero_cita, missing vacío
`;


  const body = {
    contents: [
      { role: "user", parts: [{ text: systemPrompt + "\nUsuario: " + userText }] }
    ]
  };

  const resp = await fetch(`${GEMINI_URL}?key=${GEMINI_API_KEY}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";

  try {
    const jsonStart = text.indexOf("{");
    const jsonEnd = text.lastIndexOf("}");
    const json = JSON.parse(text.slice(jsonStart, jsonEnd + 1));
    return {
      intent: json.intent || "otro",
      data: json.data || {}
    };
  } catch {
    return { intent: "otro", data: {} };
  }
}
