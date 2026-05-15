export type ToolParameter = {
  type: string;
  description?: string;
};

export type Tool = {
  type: string;
  function: {
    name: string;
    description: string;
    parameters: {
      type: string;
      properties: Record<string, ToolParameter>;
      required?: string[];
    };
  };
};

export const tools: Tool[] = [
  {
    type: "function",
    function: {
      name: "web_search",
      description: "最新情報をWeb検索する",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "検索クエリ"
          }
        },
        required: ["query"]
      }
    }
  }
];

export default tools;