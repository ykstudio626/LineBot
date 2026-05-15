// SDK V8用 LineBot
// V9になるとReplyMessageなどの仕様が変わるので注意

import { Client } from "@line/bot-sdk";
import OpenAI from "openai";
import type { CreateChatCompletionRequestMessage } from "openai/resources/chat/completions/completions.js";
import tools from "./tools.js";
import { web_search } from "./functions.js";

const lineClient = new Client({
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN as string
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MEMORY_NUM = 20; // 会話を保持する数

// -----------------------------------
// 会話メモリ
// -----------------------------------

// メッセージ型（限定して安全に扱う）
type MessageRecord = {
  role: "system" | "user" | "assistant";
  content: string;
};

const memories: Record<string, MessageRecord[]> = {};

// -----------------------------------
// Webhook
// -----------------------------------

export default async function handler(req: any, res: any): Promise<void> {

  // GET確認用
  if (req.method === "GET") {
    res.status(200).send("HELLO");
    return;
  }

  // POST以外拒否
  if (req.method !== "POST") {
    res.status(405).send("Method Not Allowed");
    return;
  }

  try {

    const events = Array.isArray(req.body?.events) ? req.body.events : [];

    for (const event of events) {

      // テキスト以外無視
      if (
        event.type !== "message" ||
        event.message?.type !== "text"
      ) {
        continue;
      }

      // -----------------------------------
      // 発言内容
      // -----------------------------------

      const userMessage: string = event.message.text;

      // -----------------------------------
      // 会話部屋ID
      // -----------------------------------

      const memoryKey: string =
        event.source?.groupId ||
        event.source?.roomId ||
        event.source?.userId ||
        "unknown";

      // -----------------------------------
      // メモリ初期化
      // -----------------------------------

      if (!memories[memoryKey]) {
        memories[memoryKey] = [];
      }

      // -----------------------------------
      // ユーザ発言保存
      // -----------------------------------

      memories[memoryKey].push({
        role: "user",
        content: userMessage
      });

      // -----------------------------------
      // 直近10件だけ保持
      // -----------------------------------

      // 直近n件だけ保持
      memories[memoryKey] =
        memories[memoryKey].slice(-1 * MEMORY_NUM);

      // -----------------------------------
      // OpenAI
      // -----------------------------------

      // メッセージを作成
      const messages: CreateChatCompletionRequestMessage[] = [
        {
          role: "system",
          content:
            "あなたは親切なAIアシスタントです。" +
            "日本語で自然に会話してください。"
        },
        ...memories[memoryKey].map((m) => ({
          role: m.role,
          content: m.content
        }))
      ];

      // メッセージを送信
      const completion = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages,
        functions: tools.map(t => t.function)
      });

      // AIからの回答（初期）
      const message = completion.choices?.[0]?.message;
      const aiText: string = (message?.content as string) ?? "";

      // tool_calls（新）または function_call（旧）に対応
      const rawToolCalls = message?.tool_calls ?? (message?.function_call ? [message.function_call] : undefined);

      console.log("rawToolCalls:" + rawToolCalls);

      let finalReply = aiText;

      if (rawToolCalls && rawToolCalls.length > 0) {
        for (const call of rawToolCalls) {
          // 呼び出し情報を正規化
          const func = (((call as any).function) ?? (call as any)) as any;
          const name = String(func?.name ?? "");
          const argsRaw = func?.arguments ?? func?.args ?? "";

          console.log("name:" , name)
          console.log("argsRaw:", argsRaw)

          // args をパース（JSONパース失敗は例外として上位へ伝搬）
          const args: any = typeof argsRaw === "string" && argsRaw ? JSON.parse(argsRaw) : (argsRaw ?? {});

          // 実際のツール実行（ここでは web_search を簡易実装）
          let toolResult: any;


          // function_calling 部分
          if (name === "web_search") {
            let query = args.query ?? "";

            // クエリが「最新」「最近」「ニュース」など一般的な表現の場合、
            // 検索に時点（年月日）を明示的に付与して最新性を担保する。
            // 既に日付が含まれている場合はそのまま使用する。
            try {
              const genericRe = /最新|最近|ニュース/;
              const datePresentRe = /\d{4}年\s*\d{1,2}月\s*\d{1,2}日|\d{4}-\d{1,2}-\d{1,2}/;

              if (genericRe.test(query) && !datePresentRe.test(query)) {
                const now = new Date();
                // JSTに合わせる
                const jst = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Tokyo" }));
                const y = jst.getFullYear();
                const m = jst.getMonth() + 1;
                const d = jst.getDate();
                const dateStr = `${y}年${m}月${d}日`;

                // "最新のテックニュース" のようにトピックが含まれている場合は
                // 日付を先頭に付けて "YYYY年M月D日の最新の<トピック>" とする。
                // トピック情報がない（単に "最新" など）の場合は
                // "YYYY年M月D日の最新のニュース" とする。
                const cleaned = query.replace(/最新の|最近の|最新|最近/g, "").trim();

                if (!cleaned || cleaned === "ニュース") {
                  query = `${dateStr}の最新のニュース`;
                } else {
                  // 例: "最新のテックニュース" -> "2026年5月15日の最新のテックニュース"
                  query = `${dateStr}の最新の${cleaned}`;
                }

                console.log("Normalized web_search query:", query);
              }

              toolResult = await web_search(query);
            } catch (e: any) {
              toolResult = `web_search error: ${e?.message ?? String(e)}`;
            }
          } else {
            toolResult = `No implementation for tool: ${name}`;
          }

          // モデルへ function の返答を渡して最終応答を取得
          const funcPrompt =
            "あなたは親切なAIアシスタントです。直前に与えられた関数の出力を参考にして、ユーザーの質問に対する最終回答を日本語で簡潔に作成してください。\n不確かな点は「不明です」と明示してください。出典URLがある場合はリンクとともに必ず明記してください。";

          const followupMessages = [
            ...messages,
            { role: "system", content: funcPrompt } as any,
            {
              role: "function",
              name,
              content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult)
            } as any
          ];

          // ツールの応答を埋め込んでAIに再送信
          const followup = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: followupMessages
          });

          // 最終応答を抽出
          finalReply = (followup.choices?.[0]?.message?.content as string) ?? finalReply;

          console.log("finalReply", finalReply);
        }
      }

      // AI返答保存（最終）
      memories[memoryKey].push({
        role: "assistant",
        content: finalReply
      });

      // LINE返信（最終）
      await lineClient.replyMessage(event.replyToken, [
        {
          type: "text",
          text: finalReply
        }
      ]);
    }

    res.status(200).send("OK");

  } catch (err) {

    console.error(err);

    res.status(500).send("ERROR");
  }
}
