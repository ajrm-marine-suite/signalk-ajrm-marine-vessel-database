"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { classifyMmsi } = require("../plugin/mmsi-classification");

test("classifies 111MIDXXX as SAR aircraft and recognizes the optional helicopter digit", () => {
  assert.deepEqual(classifyMmsi("111000599"), {
    category: "sar-aircraft",
    categoryDetail: "helicopter",
    categoryLabel: "SAR aircraft (helicopter)",
    collisionCandidate: false,
    onlineShipLookupEligible: false,
  });
});

test("does not infer aircraft from an ordinary-MMSI hovercraft description", () => {
  assert.deepEqual(classifyMmsi("235900099"), {
    category: "vessel",
    categoryDetail: null,
    categoryLabel: "Vessel / surface craft",
    collisionCandidate: true,
    onlineShipLookupEligible: true,
  });
});
