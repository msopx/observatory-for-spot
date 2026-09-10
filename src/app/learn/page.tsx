import { MechanismCasebooks } from "../../components/mechanism-casebooks";
export default function LearnPage() {
  return (
    <>
      <section className="hero">
        <div className="eyebrow">Learn · mechanics</div>
        <h1>Understand what moves underneath.</h1>
        <p className="lede">
          Two short casebooks connect the numbers to protocol mechanics:
          explore collateral rotation, and separate backing from the price of
          an exit. Recorded Broker quotes live on the Broker page.
        </p>
      </section>
      <div className="grid two section">
        <a className="card" href="#rollover-mechanics">
          <div className="eyebrow">01 · Mechanism</div>
          <h3>Why collateral rotates</h3>
          <p className="muted">
            Fresh vintages, maturity and exposure to underlying AMPL.
          </p>
        </a>
        <a className="card" href="#holder-claims">
          <div className="eyebrow">02 · Holder guide</div>
          <h3>Backing, redemption, exit</h3>
          <p className="muted">The measurements answer different questions.</p>
        </a>
      </div>
      <MechanismCasebooks />
    </>
  );
}
