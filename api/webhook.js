import express from 'express';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import { sendText } from '../lib/whatsapp.js';
import { extractEntities } from '../lib/gemini.js';
import { appendAppointment, getBookedSlotsByDate, toISO, updateAppointmentByNumero } from '../lib/sheets.js';

dayjs.extend(utc);
dayjs.extend(timezone);

const TZ = process.env.TIMEZONE || 'America/Guayaquil';
const sessions = new Map();
const SESSION_TTL_MS = 20 * 60 * 1000;

const REQUIRED_FIELDS = [
  'nombre_paciente',
  'numero_cedula',
  'nombre_contacto',
  'celular_contacto',
  'fecha_cita'
];

const router = express.Router();

// Verificación webhook
router.get('/', (req, res) => {
  const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
  if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
    return res.status(200).send(req.query['hub.challenge']);
  }
  return res.sendStatus(403);
});

// Mensajes entrantes
router.post('/', async (req, res) => {
  try {
    const { from, text } = normalizeIncoming(req.body);
    if (!from || !text) return res.sendStatus(200);

    const session = getSession(from);
    const msg = text.trim();
    const { intent, entities } = await extractEntities(msg);

    if (isCancel(msg) || intent === 'cancelar') {
      await handleCancel(from, session);
      return res.sendStatus(200);
    }
    if (isReschedule(msg) || intent === 'reagendar') {
      await handleRescheduleInit(from, session);
      return res.sendStatus(200);
    }

    applyEntitiesToSession(session, entities, from);

    if (session.mode === 'reagendar:esperando_fecha') {
      if (!session.draft.fecha_cita) {
        await askForDate(from);
      } else {
        await finalizeReschedule(from, session);
      }
      return res.sendStatus(200);
    }

    if (!session.mode) session.mode = 'agendar';

    const datePart = session.draft.fecha_cita ? session.draft.fecha_cita.slice(0, 10) : null;
    const timePart = session.draft.fecha_cita ? session.draft.fecha_cita.slice(11, 16) : null;

    if (datePart && (!timePart || timePart === '00:00')) {
      const options = await getAvailableTimes(datePart);
      session.pending = { expect: 'hora', date: datePart, options };
      await suggestTimes(from, datePart, options);
      return res.sendStatus(200);
    }

    if (session.pending?.expect === 'hora') {
      const chosen = parseHourChoice(msg, session.pending.options);
      if (!chosen) {
        await sendText(from, 'Elige una de estas horas enviando exactamente la opción (ej: 15:00).');
        return res.sendStatus(200);
      }
      session.draft.fecha_cita = `${session.pending.date}T${chosen}`;
      session.pending = null;
    }

    const missing = getMissing(session.draft, REQUIRED_FIELDS);
    if (missing.length > 0) {
      await askForNextMissing(from, session, missing[0]);
      return res.sendStatus(200);
    }

    if (!session.draft.observaciones) {
      session.pending = { expect: 'observaciones' };
      await sendText(from, '¿Motivo de la cita? (ej: “mi hijo tiene gripe”). O escribe “omitir”.');
      return res.sendStatus(200);
    }
    if (session.pending?.expect === 'observaciones') {
      session.draft.observaciones = /omitir/i.test(msg) ? '' : msg;
      session.pending = null;
    }

    if (!session.pending?.expect) {
      session.pending = { expect: 'confirmacion' };
      await sendConfirmation(from, session.draft);
      return res.sendStatus(200);
    }

    if (session.pending?.expect === 'confirmacion') {
      if (isYes(msg)) {
        await finalizeCreate(from, session);
      } else if (isNo(msg)) {
        await sendText(from, '¿Qué dato quieres cambiar?');
      } else {
        await sendText(from, '¿Confirmamos la cita? Responde “sí” o “no”.');
      }
      return res.sendStatus(200);
    }

    return res.sendStatus(200);
  } catch (e) {
    console.error(e);
    return res.sendStatus(200);
  }
});

export default router;

/* ===== Helpers ===== */

function normalizeIncoming(body) {
  const from = body?.from || body?.contacts?.[0]?.wa_id || body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.from;
  const text =
    body?.text ||
    body?.message ||
    body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]?.text?.body ||
    body?.messages?.[0]?.text?.body;
  return { from, text };
}

function getSession(userId) {
  const now = Date.now();
  let s = sessions.get(userId);
  if (!s || now > (s.expiresAt || 0)) {
    s = {
      id: userId,
      mode: null,
      draft: {
        numero_cita: null,
        nombre_paciente: null,
        numero_cedula: null,
        nombre_contacto: null,
        celular_contacto: null,
        fecha_cita: null,
        status_cita: null,
        observaciones: null
      },
      pending: null,
      expiresAt: now + SESSION_TTL_MS
    };
    sessions.set(userId, s);
  } else {
    s.expiresAt = now + SESSION_TTL_MS;
  }
  return s;
}

function applyEntitiesToSession(session, entities, from) {
  if (!entities) return;
  const d = session.draft;
  if (entities.nombre_paciente && !d.nombre_paciente) d.nombre_paciente = entities.nombre_paciente;
  if (entities.numero_cedula && !d.numero_cedula) d.numero_cedula = entities.numero_cedula;
  if (entities.celular_contacto) {
    d.celular_contacto = normalizePhone(entities.celular_contacto);
  } else if (!d.celular_contacto && from) {
    d.celular_contacto = normalizePhone(from);
  }
  if (entities.fecha_cita) {
    const iso = toISO(entities.fecha_cita);
    if (iso) d.fecha_cita = iso;
  }
  if (entities.observaciones && !d.observaciones) d.observaciones = entities.observaciones;
  if (!d.nombre_contacto && d.nombre_paciente) d.nombre_contacto = d.nombre_paciente;
}

function normalizePhone(p) {
  return p.replace(/[^\d+]/g, '');
}

function getMissing(draft, required) {
  return required.filter(k => !draft[k]);
}

async function askForNextMissing(to, session, field) {
  const prompts = {
    nombre_paciente: '¿Cuál es el nombre completo del paciente?',
    numero_cedula: '¿Número de cédula del paciente?',
    nombre_contacto: '¿A nombre de qué contacto registramos la cita?',
    celular_contacto: '¿Número de teléfono de contacto?',
    fecha_cita: '¿Para qué fecha necesitas la cita? (dd/mm/aaaa)'
  };
  session.pending = { expect: field };
  await sendText(to, prompts[field] || '¿Podrías compartir ese dato?');
}

async function askForDate(to) {
  await sendText(to, '¿Para qué fecha necesitas la cita? (dd/mm/aaaa)');
}

async function suggestTimes(to, datePart, options) {
  if (!options.length) {
    await sendText(to, `Para el ${formatDateHuman(datePart)} no hay horas disponibles. ¿Otra fecha?`);
    return;
  }
  const list = options.map(h => `- ${h}`).join('\n');
  await sendText(to, `Horas disponibles para el ${formatDateHuman(datePart)}:\n${list}\nElige una hora (ej: 15:00).`);
}

function parseHourChoice(msg, options) {
  const m = msg.match(/\b(\d{1,2}):(\d{2})\b/);
  if (!m) return null;
  const hhmm = `${m[1].padStart(2, '0')}:${m[2]}`;
  return options.includes(hhmm) ? hhmm : null;
}

function formatDateHuman(isoDate) {
  return dayjs.tz(isoDate, TZ).format('DD/MM/YYYY');
}

function formatDateTimeHuman(iso) {
  return dayjs.tz(iso, TZ).format('DD/MM/YYYY HH:mm');
}

function isYes(t) {
  return /\b(s[ií]|claro|confirmo|ok|dale)\b/i.test(t);
}

function isYes(t) {
  return /\b(s[ií]|claro|confirmo|ok|dale)\b/i.test(t);
}

function isNo(t) {
  return /\b(no|mejor no|aún no)\b/i.test(t);
}

function isCancel(t) {
  return /(cancel|anular|ya no|cancelemos)/i.test(t);
}

function isReschedule(t) {
  return /(re.?agend|cambiar|mover|otra hora|otro día)/i.test(t);
}

async function sendConfirmation(to, d) {
  const resumen =
    `Perfecto. Estos son los datos que tengo:\n` +
    `- Paciente: ${d.nombre_paciente}\n` +
    `- Cédula: ${d.numero_cedula}\n` +
    `- Contacto: ${d.nombre_contacto}\n` +
    `- Teléfono: ${d.celular_contacto}\n` +
    `- Fecha y hora: ${formatDateTimeHuman(d.fecha_cita)}\n` +
    (d.observaciones ? `- Motivo: ${d.observaciones}\n` : '') +
    `¿Confirmamos la cita? Responde “sí” o “no”.`;
  await sendText(to, resumen);
}

async function finalizeCreate(to, session) {
  const d = session.draft;
  d.numero_cita = buildNumeroCita(d.fecha_cita);
  d.status_cita = 'agendada';

  const row = {
    numero_cita: d.numero_cita,
    nombre_paciente: d.nombre_paciente,
    numero_cedula: d.numero_cedula,
    nombre_contacto: d.nombre_contacto || d.nombre_paciente,
    celular_contacto: d.celular_contacto,
    fecha_cita: formatDateTimeHuman(d.fecha_cita),
    status_cita: d.status_cita,
    observaciones: d.observaciones || ''
  };

  await appendAppointment(row);
  await sendText(to, `¡Listo! Tu cita quedó agendada para ${formatDateTimeHuman(d.fecha_cita)}. Número de cita: ${d.numero_cita}.`);
  resetSession(session);
}

async function handleCancel(to, session) {
  if (session?.draft?.numero_cita) {
    await updateAppointmentByNumero(session.draft.numero_cita, {
      status_cita: 'cancelado',
      observaciones: appendNote(session.draft.observaciones, '[Cancelado por usuario]')
    });
    await sendText(to, 'Tu cita fue cancelada. ¿Deseas agendar una nueva?');
    resetSession(session);
    return;
  }
  await sendText(to, 'Para cancelar, comparte el número de cita o la fecha y nombre para ubicarla.');
  session.mode = 'cancelar';
}

async function handleRescheduleInit(to, session) {
  session.mode = 'reagendar:esperando_fecha';
  session.pending = { expect: 'fecha' };
  await sendText(to, 'Claro, ¿para qué fecha te gustaría reprogramar? (dd/mm/aaaa)');
}

async function finalizeReschedule(to, session) {
  const d = session.draft;
  d.status_cita = 're agendado';
  if (!d.numero_cita) d.numero_cita = buildNumeroCita(d.fecha_cita);

  await updateAppointmentByNumero(d.numero_cita, {
    fecha_cita: formatDateTimeHuman(d.fecha_cita),
    status_cita: d.status_cita,
    observaciones: appendNote(d.observaciones, '[Reagendado por usuario]')
  });

  await sendText(to, `Tu cita fue reprogramada para ${formatDateTimeHuman(d.fecha_cita)}. Número de cita: ${d.numero_cita}.`);
  resetSession(session);
}

function appendNote(base, note) {
  return base ? `${base} ${note}` : note;
}

function resetSession(session) {
  if (!session) return;
  session.mode = null;
  session.pending = null;
  session.draft = {
    numero_cita: null,
    nombre_paciente: null,
    numero_cedula: null,
    nombre_contacto: null,
    celular_contacto: null,
    fecha_cita: null,
    status_cita: null,
    observaciones: null
  };
}

function buildNumeroCita(fechaISO) {
  const d = dayjs.tz(fechaISO, TZ);
  const ymd = d.format('YYYYMMDD');
  const rand = Math.floor(Math.random() * 9000 + 1000);
  return `${ymd}-${rand}`;
}

async function getAvailableTimes(dateISOYYYYMMDD) {
  const openHour = 9;
  const closeHour = 17;
  const stepMinutes = 30;
  const bookedISO = await getBookedSlotsByDate(`${dateISOYYYYMMDD}T00:00`);

  const slots = [];
  for (let h = openHour; h < closeHour; h++) {
    for (let m = 0; m < 60; m += stepMinutes) {
      const hh = String(h).padStart(2, '0');
      const mm = String(m).padStart(2, '0');
      const isBooked = bookedISO.some(b => b.slice(11, 16) === `${hh}:${mm}`);
      if (!isBooked) slots.push(`${hh}:${mm}`);
    }
  }
  return slots;
}
                                                 
