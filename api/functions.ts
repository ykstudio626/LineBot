import fetch from "node-fetch";

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "";
const TAVILY_API_BASE = process.env.TAVILY_API_BASE || "";

export async function web_search(query: string): Promise<string> {
	if (!TAVILY_API_KEY) {
		throw new Error("TAVILY_API_KEY is not set");
	}

	if (!TAVILY_API_BASE) {
		throw new Error("TAVILY_API_BASE is not set");
	}

	// 実運用: Tavily の検索API に問い合わせて結果をテキストで返す
	const base = TAVILY_API_BASE.replace(/\/$/, "");

	// Use the confirmed single POST `/search` endpoint.
	const postUrl = `${base}/search`;

	const res = await fetch(postUrl, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${TAVILY_API_KEY}`,
			"Content-Type": "application/json"
		},
		body: JSON.stringify({ query })
	});

	if (!res.ok) {
		throw new Error(`Tavily API error: ${res.status} ${res.statusText}`);
	}

	const data = await res.json();

	// data の構造に応じて要約文字列を作る。ここでは仮に items[].title と url を結合する。
	if (!Array.isArray(data.items)) {
		return JSON.stringify(data);
	}

	const snippets = data.items.slice(0, 5).map((it: any) => `- ${it.title} (${it.url})`).join("\n");
	return `検索結果:\n${snippets}`;
}

export default { web_search };
