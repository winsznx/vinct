/**
 * The product, as one picture.
 *
 * Three sovereign protocols, one shared dependency, a private agreement between them, and one
 * coordinated response that is then independently checked. If somebody looks at this for five
 * seconds and takes away only "they agreed in advance and nobody handed over their keys", the
 * drawing has done its job.
 *
 * The violet is the signal travelling through the system, which is exactly what `design.md`
 * reserves it for. It is the only chromatic thing on the page.
 *
 * Two rules it follows. It animates in a loop that a reader can ignore, and it stops entirely
 * under `prefers-reduced-motion`, because a diagram that demands attention while somebody is
 * reading the text beside it is a worse diagram. And the failure variant is the same drawing
 * with the signal stopping short, so the difference between the two is legible rather than
 * decorative.
 */

import { useEffect, useState } from "react";

const PROTOCOLS = ["Atlas Lending", "Boreal Markets", "Cinder Credit"];

export type MechanismPhase = 0 | 1 | 2 | 3 | 4;

const PHASE_CAPTION: Record<MechanismPhase, string> = {
  0: "Three protocols depend on one price feed.",
  1: "They agree in advance on one bounded emergency action each.",
  2: "The feed breaks. Each protocol answers privately.",
  3: "Enough agree. The circle certifies without revealing who said what.",
  4: "Each protocol's own adapter acts. Every effect is then verified.",
};

export function Mechanism({
  phase,
  variant = "success",
  animated = true,
}: {
  phase?: MechanismPhase;
  /** `stripped` draws the cohort that was scheduled and never executed. */
  variant?: "success" | "stripped";
  animated?: boolean;
}) {
  const [auto, setAuto] = useState<MechanismPhase>(0);
  const active = phase ?? auto;

  useEffect(() => {
    if (phase !== undefined || !animated) return;
    const reduced =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setAuto(4);
      return;
    }
    const timer = setInterval(
      () => setAuto((current) => ((current + 1) % 5) as MechanismPhase),
      2200,
    );
    return () => clearInterval(timer);
  }, [phase, animated]);

  const lit = (from: MechanismPhase): boolean => active >= from;
  const acted = active >= 4 && variant === "success";

  return (
    <figure className="stack" style={{ margin: 0, gap: "var(--s4)" }}>
      <div
        className="card"
        style={{
          padding: "var(--s5)",
          background:
            "radial-gradient(120% 100% at 50% -20%, rgba(175,80,255,0.14), transparent 62%), var(--panel)",
        }}
      >
        <svg
          viewBox="0 0 420 300"
          role="img"
          aria-label="Three protocols share one dependency, agree privately, and each acts through its own adapter"
          style={{ width: "100%", height: "auto", display: "block" }}
        >
          <defs>
            <linearGradient id="signal" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#af50ff" />
              <stop offset="100%" stopColor="#6d2ba8" />
            </linearGradient>
            <filter id="glow" x="-60%" y="-60%" width="220%" height="220%">
              <feGaussianBlur stdDeviation="5" result="blur" />
              <feMerge>
                <feMergeNode in="blur" />
                <feMergeNode in="SourceGraphic" />
              </feMerge>
            </filter>
          </defs>

          {/* The shared dependency, at the top, breaking. */}
          <g>
            <rect
              x="150"
              y="14"
              width="120"
              height="34"
              rx="8"
              fill="none"
              stroke={lit(2) ? "#e1bdff" : "rgba(247,249,250,0.22)"}
              strokeWidth="1"
              strokeDasharray={lit(2) ? "4 3" : "none"}
            />
            <text
              x="210"
              y="30"
              textAnchor="middle"
              fill={lit(2) ? "#e1bdff" : "#828384"}
              fontSize="9"
              fontFamily="var(--font-mono)"
              letterSpacing="0.1em"
            >
              PYTH SOL/USD
            </text>
            <text
              x="210"
              y="42"
              textAnchor="middle"
              fill={lit(2) ? "#e1bdff" : "#474747"}
              fontSize="8"
              fontFamily="var(--font-sans)"
            >
              {lit(2) ? "reporting bad prices" : "shared dependency"}
            </text>
          </g>

          {/* Each protocol's line up to the dependency. */}
          {PROTOCOLS.map((_, index) => {
            const x = 70 + index * 140;
            return (
              <path
                key={`feed-${index}`}
                d={`M ${x} 96 L ${x} 70 Q ${x} 60 ${x < 210 ? x + 10 : x - 10} 60 L ${x < 210 ? 200 : 220} 60 Q 210 60 210 52`}
                fill="none"
                stroke={lit(2) ? "rgba(225,189,255,0.5)" : "rgba(247,249,250,0.12)"}
                strokeWidth="1"
              />
            );
          })}

          {/* The covenant band. Drawn only once they have agreed. */}
          <rect
            x="34"
            y="150"
            width="352"
            height="1"
            fill={lit(1) ? "rgba(175,80,255,0.4)" : "rgba(247,249,250,0.1)"}
          />
          <text
            x="210"
            y="145"
            textAnchor="middle"
            fill={lit(1) ? "#af50ff" : "#474747"}
            fontSize="8"
            fontFamily="var(--font-mono)"
            letterSpacing="0.16em"
          >
            {lit(1) ? "COVENANT · 2 OF 3" : "NO AGREEMENT"}
          </text>

          {PROTOCOLS.map((name, index) => {
            const x = 70 + index * 140;
            // In the stripped run the third protocol could not act, and none of them did.
            const thisActed = acted;
            return (
              <g key={name}>
                {/* The protocol itself. */}
                <rect
                  x={x - 52}
                  y="96"
                  width="104"
                  height="40"
                  rx="8"
                  fill="var(--raised)"
                  stroke={lit(1) ? "rgba(175,80,255,0.3)" : "rgba(247,249,250,0.14)"}
                  strokeWidth="1"
                />
                <text
                  x={x}
                  y="113"
                  textAnchor="middle"
                  fill="#f7f9fa"
                  fontSize="9.5"
                  fontFamily="var(--font-sans)"
                  fontWeight="500"
                >
                  {name.split(" ")[0]}
                </text>
                <text
                  x={x}
                  y="125"
                  textAnchor="middle"
                  fill="#828384"
                  fontSize="8"
                  fontFamily="var(--font-sans)"
                >
                  {name.split(" ")[1]}
                </text>

                {/* The private response. A sealed mark, never a count. */}
                <g opacity={lit(2) ? 1 : 0.18}>
                  <rect
                    x={x - 16}
                    y="158"
                    width="32"
                    height="18"
                    rx="4"
                    fill={lit(3) ? "url(#signal)" : "none"}
                    stroke={lit(2) ? "rgba(175,80,255,0.55)" : "rgba(247,249,250,0.2)"}
                    strokeWidth="1"
                    filter={lit(3) ? "url(#glow)" : undefined}
                  />
                  <path
                    d={`M ${x - 4} 167 v -3 a 4 4 0 0 1 8 0 v 3`}
                    fill="none"
                    stroke={lit(3) ? "#14001f" : "#828384"}
                    strokeWidth="1.2"
                  />
                  <rect
                    x={x - 6}
                    y="166"
                    width="12"
                    height="7"
                    rx="1.5"
                    fill={lit(3) ? "#14001f" : "#828384"}
                  />
                </g>

                {/* The bounded action, and its own adapter. */}
                <line
                  x1={x}
                  y1="176"
                  x2={x}
                  y2="216"
                  stroke={thisActed ? "url(#signal)" : "rgba(247,249,250,0.12)"}
                  strokeWidth={thisActed ? "1.6" : "1"}
                  strokeDasharray={active === 4 && !thisActed ? "3 3" : "none"}
                />
                <rect
                  x={x - 52}
                  y="216"
                  width="104"
                  height="42"
                  rx="8"
                  fill={thisActed ? "rgba(175,80,255,0.1)" : "var(--raised)"}
                  stroke={thisActed ? "rgba(175,80,255,0.5)" : "rgba(247,249,250,0.14)"}
                  strokeWidth="1"
                />
                <text
                  x={x}
                  y="232"
                  textAnchor="middle"
                  fill={thisActed ? "#e1bdff" : "#828384"}
                  fontSize="8"
                  fontFamily="var(--font-mono)"
                  letterSpacing="0.08em"
                >
                  {thisActed ? "PAUSED" : active === 4 ? "NO ACTION" : "ADAPTER"}
                </text>
                <text
                  x={x}
                  y="245"
                  textAnchor="middle"
                  fill="#474747"
                  fontSize="7.5"
                  fontFamily="var(--font-sans)"
                >
                  owned by {name.split(" ")[0]}
                </text>
              </g>
            );
          })}

          {/* The verification line. Present in both variants: it is what says which happened. */}
          <g opacity={active >= 4 ? 1 : 0.2}>
            <rect
              x="34"
              y="272"
              width="352"
              height="1"
              fill={
                variant === "success" && active >= 4
                  ? "rgba(175,80,255,0.45)"
                  : "rgba(225,189,255,0.35)"
              }
            />
            <text
              x="210"
              y="288"
              textAnchor="middle"
              fill={variant === "success" ? "#af50ff" : "#e1bdff"}
              fontSize="8"
              fontFamily="var(--font-mono)"
              letterSpacing="0.14em"
            >
              {active < 4
                ? "INDEPENDENT VERIFICATION"
                : variant === "success"
                  ? "3 OF 3 OBSERVED · SETTLED"
                  : "0 OF 3 OBSERVED · COMMIT WITHOUT ACTIONS"}
            </text>
          </g>
        </svg>
      </div>

      <figcaption className="t-base muted" style={{ minHeight: "2.6em" }}>
        {variant === "stripped" && active >= 4
          ? "The scheduling transaction succeeded and no protocol acted. VINCT reports that rather than reporting success."
          : PHASE_CAPTION[active]}
      </figcaption>
    </figure>
  );
}
