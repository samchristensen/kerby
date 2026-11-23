// The <operator-mascot> custom element (public/operator-mascot.js, loaded once in layout.tsx); see Mascot in _components/ui.tsx.
import "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "operator-mascot": React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        state?: "focused" | "friendly" | "thinking" | "walking";
        size?: string | number;
        "no-intro"?: string | undefined;
        "no-orbit"?: string | undefined;
      };
    }
  }
}
