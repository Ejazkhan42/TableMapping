import { useEffect } from "react";
import parseCssOverrides from "../utils/cssInterpreter";

export default function useCssOverrides(cssOverrides?: string, enabled?: boolean) {
  useEffect(() => {
    if (!enabled) {
      return;
    }
    try {
      const parsedCss = parseCssOverrides(cssOverrides);
      if (parsedCss) {
        let style = document.getElementById("css-overrides");
        if (!style) {
          style = document.createElement("style");
          style.setAttribute("id", "css-overrides");
          document.head.append(style);
        }
        style.textContent = decodeURIComponent(parsedCss);
      }
    } catch (error) {
      console.error("Failed to parse CSS overrides", error);
    }
  }, [cssOverrides, enabled]);
}
