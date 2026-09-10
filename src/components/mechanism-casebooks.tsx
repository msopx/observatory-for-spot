"use client";
import { useState } from "react";
import {
  EXPLAINER_CONTRACT,
  MECHANISM_CASEBOOKS,
} from "../content/mechanism-casebooks";

function MechanismCasebook({
  book,
}: {
  book: (typeof MECHANISM_CASEBOOKS)[number];
}) {
  const [stage, setStage] = useState(0);
  const active = book.stages[stage]!;
  return (
    <article className="card section" id={book.id}>
      <div className="eyebrow">
        {book.number} · {book.tag}
      </div>
      <h2>{book.title}</h2>
      <div
        className="button-row broker-stage-tabs"
        aria-label={`${book.title} stages`}
      >
        {book.stages.map((item, index) => (
          <button
            key={item.title}
            type="button"
            aria-pressed={stage === index}
            className={stage === index ? "" : "secondary"}
            onClick={() => setStage(index)}
          >
            {index + 1}. {item.title}
          </button>
        ))}
      </div>
      <div className="broker-stage-panel" aria-live="polite">
        <h3>{active.title}</h3>
        <p>{active.description}</p>
      </div>
      <p className="muted">
        Factual mechanism explanation. This sequence does not simulate future
        prices, future rollovers or investment returns.
      </p>
      <a href={book.source} target="_blank" rel="noreferrer">
        {book.sourceLabel} ↗
      </a>
      <p className="muted">
        {EXPLAINER_CONTRACT.name}: {EXPLAINER_CONTRACT.address}
      </p>
    </article>
  );
}

export function MechanismCasebooks() {
  return (
    <>
      {MECHANISM_CASEBOOKS.map((book) => (
        <MechanismCasebook key={book.id} book={book} />
      ))}
    </>
  );
}
