/**
 * Classifies MMSI in the AJRM Marine Vessel Database Signal K server.
 */

"use strict";

function classifyMmsi(mmsi) {
  const value = String(mmsi || "").trim();
  if (/^111\d{6}$/.test(value)) {
    const typeDigit = value[6];
    const detail = typeDigit === "1" ? "fixed-wing" : typeDigit === "5" ? "helicopter" : null;
    return {
      category: "sar-aircraft",
      categoryDetail: detail,
      categoryLabel: detail ? `SAR aircraft (${detail})` : "SAR aircraft",
      collisionCandidate: false,
      onlineShipLookupEligible: false,
    };
  }
  return {
    category: "vessel",
    categoryDetail: null,
    categoryLabel: "Vessel / surface craft",
    collisionCandidate: true,
    onlineShipLookupEligible: true,
  };
}

module.exports = { classifyMmsi };
