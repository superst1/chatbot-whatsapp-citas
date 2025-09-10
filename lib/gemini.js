// Módulo de extracción semántica. Primero regex robusto, y deja un hook para LLM.
export async function extractEntities(text) {
  const t = (text || '').trim();

  // Intenciones principales
  const intent = detectIntent(t);

  // Regex básicos
  const nombrePaciente = matchNombrePaciente(t);
  const numeroCedula = matchCedula(t);
  const celular = matchTelefono(t);
  const fechaISO = matchFechaHoraISO(t);
  const motivo = matchMotivo(t);

  return {
    intent, // 'agendar' | 'reagendar' | 'cancelar' | 'consulta' | null
    entities: {
      nombre_paciente: nombrePaciente,
      numero_cedula: numeroCedula,
      celular_contacto: celular,
      fecha_cita: fechaISO,
      observaciones: motivo
    }
  };

  // Si quieres activar LLM, aquí añades tu llamada y haces un merge:
  // const llm = await callLLM(t);
  // return deepMerge(regex, llm);
}

function detectIntent(t) {
  const s = t.toLowerCase();
  if (/(re.?agend|cambiar|mover|otra hora|otro día)/.test(s)) return 'reagendar';
  if (/(cancelar|anular|ya no|no podr|cancelemos)/.test(s)) return 'cancelar';
  if (/(agendar|cita|reservar|quiero|agenda)/.test(s)) return 'agendar';
  if (/(consulta|información|info|pregunta)/.test(s)) return 'consulta';
  return null;
}

function matchCedula(t) {
  const m = t.match(/\b(\d{10,13})\b/);
  return m ? m[1] : null;
}

function matchTelefono(t) {
  const m = t.match(/\b(\+?\d{10,13})\b/);
  return m ? m[1] : null;
}

function matchNombrePaciente(t) {
  // Busca patrones "soy X", "mi nombre es X", o "X, cédula ..."
  const m1 = t.match(/(?:soy|mi nombre es)\s+([a-záéíóúñ\s]+)(?:,|\.|$)/i);
  if (m1) return sanitizeName(m1[1]);
  const m2 = t.match(/^([a-záéíóúñ\s]{3,})[,;]\s*c(é|e)dula/i);
  if (m2) return sanitizeName(m2[1]);
  // fallback: primer bloque de dos palabras capitalizadas
  const m3 = t.match(/\b([A-ZÁÉÍÓÚÑ][a-záéíóúñ]+(?:\s+[A-ZÁÉÍÓÚÑ][a-záéíóúñ]+)+)\b/);
  if (m3) return sanitizeName(m3[1]);
  return null;
}

function sanitizeName(s) {
  return s.replace(/\s+/g, ' ').trim();
}

function matchFechaHoraISO(t) {
  // Captura dd/mm/yyyy hh:mm o variantes
  const m = t.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4})(?:[^\d]+(\d{1,2}):(\d{2}))?/);
  if (!m) return null;
  const [_, fecha, hh, mm] = m;
  const [d, M, y] = fecha.split(/[\/\-]/).map(x => x.padStart(2, '0'));
  const hour = (hh || '00').padStart(2, '0');
  const min = (mm || '00').padStart(2, '0');
  return `${y}-${M}-${d}T${hour}:${min}`;
}

function matchMotivo(t) {
  // Si contiene frase tipo "tiene gripe", "dolor de cabeza", etc., usamos todo el mensaje como observación cuando se pide explícitamente
  // En flujo guiado, pedimos observaciones y usamos respuesta tal cual.
  return null;
}
