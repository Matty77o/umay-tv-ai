/**
 * Umay TV AI — Cloudflare Worker
 *
 *   /api/chat     — the original chat page (unchanged behaviour)
 *   /api/adviser  — used by the Umay TV Guide Android app
 *
 * /api/adviser has two modes, decided by the request body:
 *   - no "question"  -> channel advice:
 *       { summary, focus, existing:[{channel,verdict,reason}],
 *         add:[{channel,language,ageFit,priority,reason}] }
 *   - with "question" -> question answer:
 *       { answer, programmes:[{programme,channel,reason}] }
 *
 * Small models often wrap JSON in prose or code fences, or cut it off. This
 * worker extracts and repairs the JSON, retries once with a stricter prompt and
 * a second model, and as a last resort returns a simple non-AI answer instead
 * of an HTTP 500, so the app always gets something usable.
 */
import { Env, ChatMessage } from "./types";

const CHAT_MODEL = "@cf/meta/llama-3.1-8b-instruct-fp8";

// Tried in order. The 70B model gives much better advice; the 8B one is the
// fallback if the larger model is unavailable or out of quota.
const ADVISER_MODELS = [
	"@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	"@cf/meta/llama-3.1-8b-instruct-fp8",
];

const SYSTEM_PROMPT =
	"You are a helpful, friendly assistant. Provide concise and accurate responses.";

const JSON_HEADERS = {
	"content-type": "application/json; charset=utf-8",
	"cache-control": "no-store",
	"access-control-allow-origin": "*",
};

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "OPTIONS") {
			return new Response(null, {
				headers: {
					"access-control-allow-origin": "*",
					"access-control-allow-methods": "POST, GET, OPTIONS",
					"access-control-allow-headers": "content-type",
				},
			});
		}

		if (url.pathname === "/" || !url.pathname.startsWith("/api/")) {
			return env.ASSETS.fetch(request);
		}

		if (url.pathname === "/api/chat") {
			if (request.method === "POST") return handleChatRequest(request, env);
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname === "/api/adviser") {
			if (request.method === "GET") {
				return json({ ok: true, endpoint: "adviser", models: ADVISER_MODELS });
			}
			if (request.method === "POST") return handleAdviserRequest(request, env);
			return new Response("Method not allowed", { status: 405 });
		}

		return new Response("Not found", { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Chat (original template)
// ---------------------------------------------------------------------------
async function handleChatRequest(request: Request, env: Env): Promise<Response> {
	try {
		const { messages = [] } = (await request.json()) as { messages: ChatMessage[] };
		if (!messages.some((msg) => msg.role === "system")) {
			messages.unshift({ role: "system", content: SYSTEM_PROMPT });
		}
		const stream = await (env.AI as any).run(CHAT_MODEL, {
			messages,
			max_tokens: 1024,
			stream: true,
		});
		return new Response(stream, {
			headers: {
				"content-type": "text/event-stream; charset=utf-8",
				"cache-control": "no-cache",
				connection: "keep-alive",
			},
		});
	} catch (error) {
		console.error("Error processing chat request:", error);
		return json({ error: "Failed to process request" }, 500);
	}
}

// ---------------------------------------------------------------------------
// Adviser
// ---------------------------------------------------------------------------
interface AdviserProgramme {
	channel?: string;
	title?: string;
	description?: string;
	category?: string;
	language?: string;
	start?: string;
	stop?: string;
}

interface AdviserRequest {
	ageMonths?: number;
	question?: string;
	currentChannels?: string[];
	excludedChannels?: string[];
	programmes?: AdviserProgramme[];
	epgAvailable?: boolean;
	epgDate?: string;
	epgWindowStart?: string;
}

async function handleAdviserRequest(request: Request, env: Env): Promise<Response> {
	let body: AdviserRequest;
	try {
		body = (await request.json()) as AdviserRequest;
	} catch {
		return json({ error: "Request body must be JSON" }, 400);
	}

	const age = clampInt(body.ageMonths, 0, 60, 12);
	const channels = cleanList(body.currentChannels, 30);
	const excluded = cleanList(body.excludedChannels, 30);
	const programmes = (Array.isArray(body.programmes) ? body.programmes : [])
		.slice(0, 30)
		.map((p) => ({
			channel: str(p.channel, 40),
			title: str(p.title, 80),
			description: str(p.description, 160),
			category: str(p.category, 30),
			language: str(p.language, 12),
			start: str(p.start, 5),
			stop: str(p.stop, 5),
		}))
		.filter((p) => p.channel && p.title);
	const question = str(body.question, 500);

	const context = [
		`Child's age: ${formatAge(age)} (${age} months).`,
		`Current kids channels: ${channels.join(", ") || "none listed"}.`,
		excluded.length ? `Never suggest these channels: ${excluded.join(", ")}.` : "",
		programmes.length
			? "On now on the kids channels (UK time):\n" +
				programmes
					.map(
						(p) =>
							`- ${p.channel}: "${p.title}" ${p.start}-${p.stop} [${p.language || "English"}]` +
							(p.description ? ` — ${p.description}` : ""),
					)
					.join("\n")
			: "No live programme listings are available right now.",
	]
		.filter(Boolean)
		.join("\n");

	const system =
		"You advise a family in the UK on children's TV for their child. The family watches English and Turkish TV. " +
		"Be practical, warm and specific, follow UK/NHS-style guidance on screen time for young children, and never invent " +
		"programmes that are not in the listings. Reply with ONE JSON object only: no markdown, no code fences, no text before or after it.";

	const task = question
		? `Question from the parent: ${question}\n\n` +
			'Reply as JSON: {"answer": "2-5 sentence answer", "programmes": [{"programme": "title from the listings above", "channel": "channel", "reason": "short reason"}]}. ' +
			"Only include programmes that appear in the listings above; use an empty array if none fit."
		: "Assess the current channel lineup for this age and suggest up to 3 additions.\n\n" +
			'Reply as JSON: {"summary": "1-2 sentences", "focus": "what to prioritise at this age, 1 sentence", ' +
			'"existing": [{"channel": "one of the current channels", "verdict": "KEEP or LOWER or LATER", "reason": "short reason"}], ' +
			'"add": [{"channel": "real English or Turkish kids channel not already listed", "language": "English or Turkish", "ageFit": "e.g. 6-24 months", "priority": "High or Medium or Low", "reason": "short reason"}]}. ' +
			"Give a verdict for every current channel.";

	const messages = [
		{ role: "system", content: system },
		{ role: "user", content: `${context}\n\n${task}` },
	];

	const errors: string[] = [];
	for (let attempt = 0; attempt < ADVISER_MODELS.length; attempt++) {
		const model = ADVISER_MODELS[attempt];
		try {
			const result: any = await (env.AI as any).run(model, {
				messages:
					attempt === 0
						? messages
						: [
								...messages,
								{
									role: "user",
									content: "Remember: output only the JSON object, starting with { and ending with }.",
								},
							],
				max_tokens: 900,
				temperature: 0.4,
			});
			const raw = typeof result?.response === "string" ? result.response : result?.response ?? result;
			const parsed = typeof raw === "object" && raw !== null ? raw : extractJson(String(raw ?? ""));
			if (!parsed) throw new Error("model reply was not valid JSON");

			const shaped = question ? shapeAnswer(parsed, programmes) : shapeAdvice(parsed, channels, excluded);
			if (shaped) return json({ ...shaped, model });
			throw new Error("model reply was missing the expected fields");
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`Adviser attempt with ${model} failed:`, message);
			errors.push(`${model}: ${message}`);
		}
	}

	// Last resort: a simple non-AI answer so the app still shows something,
	// with the reasons attached for debugging.
	console.error("All adviser attempts failed:", errors.join(" | "));
	const fallback = question
		? {
				answer:
					"I couldn't reach the AI model just now, so I can't answer that properly. Please try again in a minute.",
				programmes: [],
			}
		: {
				summary: `At ${formatAge(age)}, keep TV short and shared, and favour calm, simple programmes with songs and repetition.`,
				focus: "Slow-paced songs, first words, colours and gentle stories, watched together.",
				existing: [],
				add: [],
			};
	return json({ ...fallback, fallback: true, errors });
}

// ---------------------------------------------------------------------------
// Response shaping
// ---------------------------------------------------------------------------
function shapeAdvice(obj: any, channels: string[], excluded: string[]) {
	const summary = str(obj?.summary, 600);
	const focus = str(obj?.focus, 400);
	const lower = (s: string) => s.toLowerCase().replace(/[^a-z0-9çğıöşü]/g, "");
	const current = new Set(channels.map(lower));
	const banned = new Set(excluded.map(lower));

	const existing = (Array.isArray(obj?.existing) ? obj.existing : [])
		.map((e: any) => ({
			channel: str(e?.channel, 60),
			verdict: (["KEEP", "LOWER", "LATER"].includes(String(e?.verdict).toUpperCase())
				? String(e.verdict).toUpperCase()
				: "KEEP") as string,
			reason: str(e?.reason, 300),
		}))
		.filter((e: any) => e.channel && e.reason);

	const add = (Array.isArray(obj?.add) ? obj.add : [])
		.map((a: any) => ({
			channel: str(a?.channel, 60),
			language: /turk/i.test(String(a?.language)) ? "Turkish" : "English",
			ageFit: str(a?.ageFit, 40),
			priority: str(a?.priority, 12),
			reason: str(a?.reason, 300),
		}))
		.filter((a: any) => a.channel && a.reason && !current.has(lower(a.channel)) && !banned.has(lower(a.channel)))
		.slice(0, 3);

	if (!summary && !existing.length && !add.length) return null;
	return { summary, focus, existing, add };
}

function shapeAnswer(obj: any, listed: { title: string; channel: string }[]) {
	const answer = str(obj?.answer, 1500);
	if (!answer) return null;
	const titles = new Set(listed.map((p) => p.title.toLowerCase()));
	const programmes = (Array.isArray(obj?.programmes) ? obj.programmes : [])
		.map((p: any) => ({
			programme: str(p?.programme, 100),
			channel: str(p?.channel, 60),
			reason: str(p?.reason, 300),
		}))
		.filter((p: any) => p.programme && p.channel && (titles.size === 0 || titles.has(p.programme.toLowerCase())))
		.slice(0, 5);
	return { answer, programmes };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
/** Pull the first JSON object out of model text, repairing common problems. */
function extractJson(text: string): any | null {
	let t = text.replace(/```(?:json)?/gi, "").trim();
	const start = t.indexOf("{");
	if (start < 0) return null;
	t = t.slice(start);

	const tryParse = (s: string) => {
		try {
			return JSON.parse(s);
		} catch {
			return null;
		}
	};

	// Balanced-brace scan to find the end of the first object.
	let depth = 0,
		inStr = false,
		esc = false,
		end = -1;
	for (let i = 0; i < t.length; i++) {
		const c = t[i];
		if (inStr) {
			if (esc) esc = false;
			else if (c === "\\") esc = true;
			else if (c === '"') inStr = false;
			continue;
		}
		if (c === '"') inStr = true;
		else if (c === "{" || c === "[") depth++;
		else if (c === "}" || c === "]") {
			depth--;
			if (depth === 0) {
				end = i;
				break;
			}
		}
	}

	const candidate = end >= 0 ? t.slice(0, end + 1) : t;
	const cleaned = candidate.replace(/,\s*([}\]])/g, "$1"); // trailing commas
	let parsed = tryParse(candidate) ?? tryParse(cleaned);
	if (parsed) return parsed;

	// Truncated reply: close any open string/brackets and try again.
	if (end < 0) {
		let fixed = cleaned;
		const stack: string[] = [];
		let s = false,
			e = false;
		for (const c of fixed) {
			if (s) {
				if (e) e = false;
				else if (c === "\\") e = true;
				else if (c === '"') s = false;
				continue;
			}
			if (c === '"') s = true;
			else if (c === "{") stack.push("}");
			else if (c === "[") stack.push("]");
			else if (c === "}" || c === "]") stack.pop();
		}
		if (s) fixed += '"';
		fixed = fixed.replace(/,\s*$/, "");
		while (stack.length) fixed += stack.pop();
		parsed = tryParse(fixed.replace(/,\s*([}\]])/g, "$1"));
	}
	return parsed;
}

function json(data: unknown, status = 200): Response {
	return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function str(value: unknown, max: number): string {
	if (value === null || value === undefined) return "";
	return String(value).replace(/\s+/g, " ").trim().slice(0, max);
}

function cleanList(value: unknown, max: number): string[] {
	return (Array.isArray(value) ? value : []).map((v) => str(v, 60)).filter(Boolean).slice(0, max);
}

function clampInt(value: unknown, min: number, max: number, dflt: number): number {
	const n = Math.round(Number(value));
	return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}

function formatAge(months: number): string {
	if (months < 12) return months === 1 ? "1 month" : `${months} months`;
	const y = Math.floor(months / 12),
		m = months % 12;
	const ys = y === 1 ? "1 year" : `${y} years`;
	return m ? `${ys} ${m} month${m === 1 ? "" : "s"}` : ys;
}
