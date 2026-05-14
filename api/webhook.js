import { Client } from "@line/bot-sdk";
import OpenAI from "openai";

const lineClient = new Client({
  channelAccessToken:
    process.env.LINE_CHANNEL_ACCESS_TOKEN
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export default async function handler(
  req,
  res
) {

  // GET確認用
  if (req.method === "GET") {
    return res.status(200).send("HELLO");
  }

  // POST以外拒否
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {

    const events = req.body.events;

    for (const event of events) {

      // テキスト以外無視
      if (
        event.type !== "message" ||
        event.message.type !== "text"
      ) {
        continue;
      }

      const userMessage =
        event.message.text;

      // OpenAI
      const response =
        await openai.responses.create({
          model: "gpt-4.1-mini",

          instructions:
            "あなたは親切なAIアシスタントです。" +
            "日本語で簡潔に回答してください。",

          input: userMessage
        });

    //   const aiText =
    //     response.output[0]
    //       .content[0]
    //       .text;

      const aiText = response.output_text;

      console.log(aiText);

      // LINE返信
      await lineClient.replyMessage(
        event.replyToken,
        [
            {
            type: "text",
            text: aiText
            }
        ]
        );
    }

    return res.status(200).send("OK");

  } catch (err) {

    console.error(err);

    return res.status(500).send("ERROR");
  }
}