// SDK V8用 LineBot
// V9になるとReplyMessageなどの仕様が変わるので注意

import { Client } from "@line/bot-sdk";
import OpenAI from "openai";
import type { CreateChatCompletionRequestMessage } from "openai/resources/chat/completions/completions.js";
import tools from "./tools";

const lineClient = new Client({
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN as string
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const MEMORY_NUM = 10; // 会話を保持する数

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

          // args をパース（JSONパース失敗は例外として上位へ伝搬）
          const args: any = typeof argsRaw === "string" && argsRaw ? JSON.parse(argsRaw) : (argsRaw ?? {});

          // 実際のツール実行（ここでは web_search を簡易実装）
          let toolResult: any;


          // function_calling部分
          if (name === "web_search") {
            const query = args.query ?? "";
            // 簡易ダミー検索。必要ならここに実際の検索実装を入れてください。
            // web_search(query);
            toolResult = `検索結果のダミー: ${query}`;
          } else {
            toolResult = `No implementation for tool: ${name}`;
          }

          // モデルへ function の返答を渡して最終応答を取得
          const followupMessages = [
            ...messages,
            {
              role: "function",
              name,
              content: typeof toolResult === "string" ? toolResult : JSON.stringify(toolResult) } as any
          ];

          const followup = await openai.chat.completions.create({
            model: "gpt-4.1-mini",
            messages: followupMessages
          });

          finalReply = (followup.choices?.[0]?.message?.content as string) ?? finalReply;
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
