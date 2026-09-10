/**
 * Text-only mechanism explainers. Each stage is a factual description of
 * protocol behaviour with a link to the deployed contract's verified source on
 * the block explorer; nothing here computes or simulates.
 */
export const EXPLAINER_CONTRACT = {
  name: "SPOT implementation at the release block",
  address: "0x62cbE9F24413485F04fa62f9548c7855EC4a5425",
} as const;
const contractSource = `https://etherscan.io/address/${EXPLAINER_CONTRACT.address}#code`;

export const MECHANISM_CASEBOOKS = [
  {
    id: "rollover-mechanics",
    number: "01",
    title: "Why the collateral keeps rotating",
    tag: "Mechanism explainer",
    source: contractSource,
    sourceLabel: "Deployed SPOT contract, verified source",
    stages: [
      {
        title: "A basket of different maturities",
        description:
          "SPOT holds senior tranches and underlying collateral. Different tranche maturities spread the basket’s scheduled exposure over time. The maturity ladder shows the dates of the observed holdings.",
      },
      {
        title: "Fresh tranches enter",
        description:
          "The designated rollover vault can exchange eligible reserve assets for fresh senior tranches from the active deposit bond. Eligibility depends on the configured maturity limits and available assets.",
      },
      {
        title: "Maturity changes the reserve",
        description:
          "The contract updates its reserve state when relevant methods are called. Matured senior holdings are redeemed into underlying collateral. If no fresh rollovers occur, the basket progressively holds more underlying AMPL; maturity alone does not provide a USDC exit.",
      },
    ],
  },
  {
    id: "holder-claims",
    number: "02",
    title: "Three values, three different questions",
    tag: "Holder explainer",
    source: contractSource,
    sourceLabel: "Deployed SPOT contract, verified source",
    stages: [
      {
        title: "What backs the token?",
        description:
          "A SPOT holding represents an interest in the protocol’s reserve basket. Collateral composition answers what is held behind the token. A collateral valuation expresses that basket using a particular unit and pricing rule.",
      },
      {
        title: "What does redemption return?",
        description:
          "SPOT redemption returns amounts of the reserve tokens after the applicable fee. These can include senior tranche tokens and AMPL. It does not exchange every asset into dollars.",
      },
      {
        title: "What can I sell it for?",
        description:
          "A Broker sale exchanges SPOT for USDC using available inventory, oracle values and the configured fee curve. The recorded contract quotes on the Broker page show how that outcome changed with trade size at the snapshot. External market prices describe a separate venue or methodology.",
      },
    ],
  },
] as const;
