/*
 * <operator-mascot> — animated mascot web component.
 * Works in plain HTML, React, Vue, Svelte, Angular… (it's a standard custom element).
 *
 * Attributes:
 *   state     "focused" (default) | "friendly" | "thinking" | "walking"
 *   size      width in px or any CSS length (default 160). Height follows automatically.
 *   no-intro  if present, skip the intro animation on first load
 *   no-orbit  if present, hide the orbit ring and nodes
 *
 * JS API:
 *   el.state = "thinking";   // switch state
 *   el.playIntro();          // replay the intro
 */
(() => {
  if (customElements.get("operator-mascot")) return;

  const STATES = ["focused", "friendly", "thinking", "walking"];
  const ORBIT = "M456,286 A200,70 0 1,1 56,286 A200,70 0 1,1 456,286";
  let uid = 0;

  const nodes = () => `
    <g><circle r="17" fill="var(--om-green)" stroke="var(--om-ink)" stroke-width="6"/><animateMotion dur="8s" repeatCount="indefinite" path="${ORBIT}"/></g>
    <g><rect x="-14" y="-14" width="28" height="28" rx="7" fill="var(--om-amber)" stroke="var(--om-ink)" stroke-width="6"/><animateMotion dur="8s" begin="-2.7s" repeatCount="indefinite" path="${ORBIT}"/></g>
    <g><polygon points="0,-22 22,0 0,22 -22,0" fill="var(--om-white)" stroke="var(--om-ink)" stroke-width="6"/><animateMotion dur="8s" begin="-5.3s" repeatCount="indefinite" path="${ORBIT}"/></g>`;

  const dash = (x) => `<line x1="${x}" y1="430" x2="${x + 24}" y2="430"/>`;

  const svg = (id) => `
<svg class="op" viewBox="0 30 512 420" role="img" aria-label="Operator mascot">
  <defs><clipPath id="front-${id}" clipPathUnits="userSpaceOnUse"><polygon points="0,349.8 512,222.2 512,512 0,512"/></clipPath></defs>
  <g class="ground" stroke="var(--om-line)" stroke-width="4" stroke-linecap="round">
    <line x1="40" y1="414" x2="472" y2="414"/>
    <g class="dashes">${[40, 104, 168, 232, 296, 360, 424, 488].map(dash).join("")}</g>
  </g>
  <ellipse cx="256" cy="408" rx="96" ry="11" fill="#000" fill-opacity=".35"/>
  <g class="orbit"><g transform="rotate(-14 256 286)">
    <ellipse cx="256" cy="286" rx="200" ry="70" fill="none" stroke="var(--om-amber)" stroke-opacity=".45" stroke-width="6"/>
    ${nodes()}
  </g></g>
  <g class="char">
    <g class="footL"><rect x="184" y="372" width="64" height="32" rx="14" fill="var(--om-ink)"/><rect x="192" y="394" width="48" height="6" rx="3" fill="var(--om-green)"/></g>
    <g class="footR"><rect x="264" y="372" width="64" height="32" rx="14" fill="var(--om-ink)"/><rect x="272" y="394" width="48" height="6" rx="3" fill="var(--om-green)"/></g>
    <g class="upper">
      <g class="steam"><circle class="puff p1" cx="270" cy="54" r="13"/><circle class="puff p2" cx="270" cy="54" r="11"/><circle class="puff p3" cx="270" cy="54" r="12"/></g>
      <g class="ant">
        <line x1="256" y1="136" x2="256" y2="92" stroke="var(--om-ink)" stroke-width="16" stroke-linecap="round"/>
        <line x1="256" y1="136" x2="256" y2="92" stroke="var(--om-amber)" stroke-width="7" stroke-linecap="round"/>
        <circle cx="256" cy="80" r="17" fill="var(--om-green)" stroke="var(--om-ink)" stroke-width="7"/>
      </g>
      <ellipse cx="130" cy="300" rx="24" ry="36" transform="rotate(28 130 300)" fill="var(--om-amber)" stroke="var(--om-ink)" stroke-width="10"/>
      <g class="armR"><ellipse cx="388" cy="250" rx="24" ry="36" transform="rotate(-38 388 250)" fill="var(--om-amber)" stroke="var(--om-ink)" stroke-width="10"/></g>
      <path d="M256 132 C330 132 372 180 378 250 C384 320 380 372 330 384 L182 384 C132 372 128 320 134 250 C140 180 182 132 256 132 Z" fill="var(--om-amber)" stroke="var(--om-ink)" stroke-width="12"/>
      <path d="M196 170 Q220 152 250 150" fill="none" stroke="var(--om-amber-light)" stroke-width="10" stroke-linecap="round"/>
      <rect x="172" y="200" width="168" height="100" rx="50" fill="var(--om-ink)"/>
      <g class="eF">
        <ellipse cx="214" cy="252" rx="20" ry="27" fill="var(--om-green)"/><ellipse cx="298" cy="252" rx="20" ry="27" fill="var(--om-green)"/>
        <polygon points="188,214 242,214 242,238 188,224" fill="var(--om-ink)"/><polygon points="270,214 324,214 324,224 270,238" fill="var(--om-ink)"/>
        <circle cx="221" cy="246" r="6" fill="var(--om-white)"/><circle cx="305" cy="246" r="6" fill="var(--om-white)"/>
      </g>
      <g class="eH" fill="none" stroke="var(--om-green)" stroke-width="13" stroke-linecap="round"><path d="M196 260 Q214 230 232 260"/><path d="M280 260 Q298 230 316 260"/></g>
      <g class="eT">
        <ellipse cx="214" cy="248" rx="20" ry="27" fill="var(--om-green)"/><circle cx="221" cy="240" r="6" fill="var(--om-white)"/>
        <path d="M280 258 L316 252" fill="none" stroke="var(--om-green)" stroke-width="13" stroke-linecap="round"/>
      </g>
      <path class="mF" d="M240 322 Q258 330 276 318" fill="none" stroke="var(--om-ink)" stroke-width="8" stroke-linecap="round"/>
      <path class="mH" d="M234 314 Q256 342 278 314 Z" fill="var(--om-ink)" stroke="var(--om-ink)" stroke-width="6" stroke-linejoin="round"/>
      <path class="mT" d="M244 322 L272 318" fill="none" stroke="var(--om-ink)" stroke-width="8" stroke-linecap="round"/>
      <ellipse class="armChin" cx="356" cy="332" rx="22" ry="30" transform="rotate(-60 356 332)" fill="var(--om-amber)" stroke="var(--om-ink)" stroke-width="10"/>
    </g>
  </g>
  <g class="orbit"><g clip-path="url(#front-${id})"><g transform="rotate(-14 256 286)">
    <ellipse cx="256" cy="286" rx="200" ry="70" fill="none" stroke="var(--om-ink)" stroke-width="18"/>
    <ellipse cx="256" cy="286" rx="200" ry="70" fill="none" stroke="var(--om-amber)" stroke-width="6"/>
    ${nodes()}
  </g></g></g>
</svg>`;

  const css = `
:host{
  --om-ink:#0A0B10; --om-amber:#F2B33D; --om-amber-light:#FFD98A;
  --om-green:#39FF7F; --om-white:#FFFFFF; --om-steam:#EEF1F8; --om-line:#3A4156;
  display:inline-block; width:var(--om-size,160px); line-height:0;
}
svg{width:100%;height:auto;overflow:visible}
g,path,ellipse,rect,line{transform-box:view-box}
.puff{fill:var(--om-steam)}
.eH,.eT,.mH,.mT,.armChin,.steam,.ground{display:none}
:host([data-s="friendly"]) .eF,:host([data-s="friendly"]) .mF,
:host([data-s="thinking"]) .eF,:host([data-s="thinking"]) .mF,:host([data-s="thinking"]) .armR{display:none}
:host([data-s="friendly"]) .eH,:host([data-s="friendly"]) .mH,
:host([data-s="thinking"]) .eT,:host([data-s="thinking"]) .mT,:host([data-s="thinking"]) .armChin,:host([data-s="thinking"]) .steam,
:host([data-s="walking"]) .ground{display:inline}
:host([no-orbit]) .orbit{display:none}
.upper{animation:breathe 3s ease-in-out infinite alternate}
.eF,.eT{transform-origin:256px 250px;animation:blink 4.5s infinite}
.ant{transform-origin:256px 136px;animation:sway 2.4s ease-in-out infinite alternate}
:host([data-s="thinking"]) .ant{animation:wiggle .35s ease-in-out infinite alternate}
.armR{transform-origin:372px 266px}
:host([data-s="friendly"]) .armR{animation:wave .45s ease-in-out infinite alternate}
.puff{transform-box:fill-box;transform-origin:center;animation:rise 2s ease-out infinite;opacity:0}
.p2{animation-delay:.65s;--dx:-26px}.p3{animation-delay:1.3s;--dx:18px}
:host([data-s="walking"]) .footL{animation:shuffle .4s ease-in-out infinite alternate}
:host([data-s="walking"]) .footR{animation:shuffle .4s ease-in-out infinite alternate-reverse}
:host([data-s="walking"]) .upper{animation:bob .2s ease-in-out infinite alternate}
:host([data-s="walking"]) .armR{animation:swing .4s ease-in-out infinite alternate}
.dashes{animation:scroll .45s linear infinite}
.orbit{transform-origin:256px 286px}
.char{transform-origin:256px 404px}
:host([data-intro]) .orbit{animation:orbitIn 1.7s cubic-bezier(.2,.8,.2,1) both}
:host([data-intro]) .char{animation:drop 1s .35s cubic-bezier(.3,1.3,.5,1) both}
:host([data-intro]) .eF{animation:wake 1.8s both}
@keyframes breathe{to{transform:translateY(-5px)}}
@keyframes blink{0%,92%,100%{transform:scaleY(1)}95%{transform:scaleY(.1)}}
@keyframes sway{from{transform:rotate(-5deg)}to{transform:rotate(5deg)}}
@keyframes wiggle{from{transform:rotate(6deg)}to{transform:rotate(14deg)}}
@keyframes wave{from{transform:rotate(-28deg)}to{transform:rotate(12deg)}}
@keyframes rise{0%{transform:translate(0,0) scale(.4);opacity:0}20%{opacity:.95}100%{transform:translate(var(--dx,6px),-120px) scale(1.5);opacity:0}}
@keyframes shuffle{0%{transform:translate(-9px,0)}50%{transform:translate(0,-12px)}100%{transform:translate(9px,0)}}
@keyframes bob{to{transform:translateY(-6px)}}
@keyframes swing{from{transform:rotate(-25deg)}to{transform:rotate(20deg)}}
@keyframes scroll{to{transform:translateX(-64px)}}
@keyframes orbitIn{0%{transform:rotate(-540deg) scale(.1);opacity:0}50%{opacity:1}100%{transform:none}}
@keyframes drop{0%{transform:translateY(-480px)}55%{transform:translateY(0) scale(1.14,.84)}75%{transform:scale(.94,1.07)}100%{transform:none}}
@keyframes wake{0%,65%{transform:scaleY(.08)}100%{transform:scaleY(1)}}
@media (prefers-reduced-motion:reduce){*{animation:none!important}}`;

  class OperatorMascot extends HTMLElement {
    static get observedAttributes() {
      return ["state", "size"];
    }

    constructor() {
      super();
      const root = this.attachShadow({ mode: "open" });
      root.innerHTML = `<style>${css}</style>${svg(++uid)}`;
      this._timer = null;
    }

    connectedCallback() {
      this._apply();
      if (!this.hasAttribute("no-intro")) this.playIntro();
    }

    disconnectedCallback() {
      clearTimeout(this._timer);
    }

    attributeChangedCallback() {
      this._apply();
    }

    get state() {
      return this.dataset.s || "focused";
    }
    set state(v) {
      this.setAttribute("state", v);
    }

    playIntro() {
      clearTimeout(this._timer);
      this.removeAttribute("data-intro");
      void this.offsetWidth; // restart CSS animations
      this.setAttribute("data-intro", "");
      this._timer = setTimeout(() => this.removeAttribute("data-intro"), 2200);
    }

    _apply() {
      const s = this.getAttribute("state");
      this.dataset.s = STATES.includes(s) ? s : "focused";
      const size = this.getAttribute("size");
      if (size)
        this.style.setProperty("--om-size", /^\d+(\.\d+)?$/.test(size) ? size + "px" : size);
    }
  }

  customElements.define("operator-mascot", OperatorMascot);
})();
