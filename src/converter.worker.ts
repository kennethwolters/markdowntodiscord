import { convertMarkdown, type ConvertOptions, type ConversionResult } from "./convert.js";

type ConversionRequest = { id: number; source: string; options: ConvertOptions };
type ConversionResponse = { id: number; result: ConversionResult };

self.addEventListener("message", (event: MessageEvent<ConversionRequest>) => {
  const { id, source, options } = event.data;
  const response: ConversionResponse = { id, result: convertMarkdown(source, options) };
  self.postMessage(response);
});
