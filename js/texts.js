// Ready-to-copy text messages. Nothing is sent automatically (that needs a paid service);
// the leader copies a message and pastes it into the group chat or a text.
// Group texts never include street addresses. The one-to-one driver text does (see CONFIG.texts).

import { CONFIG } from "./config.js";
import { fmtDate, fmtMin, toMin } from "./dates.js";

const first = (name = "") => String(name).trim().split(/\s+/)[0] || "friend";
const church = () => CONFIG.churchName;
const service = () => CONFIG.service.time;
const svcLabel = () => fmtMin(toMin(service()));

/** Invitation for people with a car to join the driving team. Safe for a group chat (no personal details). */
export function inviteDrivers(appUrl = "") {
  return `Hello from ${church()}! We run a ride team so that everyone who needs a lift can get to our ${svcLabel()} Sunday service. Do you have a car and a few free seats? We'd love you to join the driving team.

How to join:
1. Open ${appUrl || "the ride app"}
2. Sign in with your email (we send you a short code or link, no password)
3. Choose "I can give rides" and fill in the short form

The transport leader will check your details and approve you before you're given any riders. You can choose which Sundays you drive, and you can always tell us when you can't make it. Thank you for serving!`;
}

export function weeklyCheckin(sunday, appUrl = "") {
  return `Good day from ${church()}. Do you need a ride this Sunday (${fmtDate(sunday)})? Please tell us in the app by Saturday 12:00 noon, and how many people are coming with you${appUrl ? `: ${appUrl}` : ""}. If we don't hear from you, we won't arrange a ride.`;
}

export function riderDetails(sunday, rider, driver, stop, partyTotal = 1) {
  const who = partyTotal > 1 && (stop.seats ?? 1) < partyTotal ? `${stop.seats} of your group of ${partyTotal}` : partyTotal > 1 ? `your group of ${partyTotal}` : "you";
  return `Hi ${first(rider.name)}, your ride for ${fmtDate(sunday)} is arranged. ${first(driver.name)}${driver.vehicle ? ` (${driver.vehicle})` : ""} will pick up ${who} around ${fmtMin(stop.pickupMin)}. Please be ready by ${fmtMin(stop.readyByMin)} to avoid delays.${driver.phone ? ` Driver's number: ${driver.phone}.` : ""} Service is at ${svcLabel()}.`;
}

export function waitlisted(sunday, rider) {
  return `Hi ${first(rider.name)}, we're still working on a seat for you on ${fmtDate(sunday)}. The transport leader will message you as soon as we have one. Thank you for your patience.`;
}

export function driverRoute(sunday, driver, cars, ridersById, groupSizes = new Map()) {
  const details = CONFIG.texts?.includeDetails !== false;
  const lines = [`Hi ${first(driver.name)}, thank you for driving on ${fmtDate(sunday)}.`];
  for (const car of cars) {
    lines.push(cars.length > 1 ? `Trip ${car.trip}:` : "Your pickups:");
    for (const s of car.stops) {
      const r = ridersById.get(s.riderId);
      const where = details
        ? [r?.address, r?.neighbourhood && !String(r?.address || "").includes(r.neighbourhood) ? `(${r.neighbourhood})` : ""].filter(Boolean).join(" ")
        : (r?.neighbourhood ? `(${r.neighbourhood})` : "");
      const phone = details && r?.phone ? `, ${r.phone}` : "";
      lines.push(`${fmtMin(s.pickupMin)}  ${r ? r.name : "Rider"}${where ? `, ${where}` : ""}${phone}`);
      const total = Math.max(groupSizes.get(s.riderId) || 1, s.seats || 1);
      const mine = s.seats || 1;
      if (total > 1) {
        lines.push(mine >= total
          ? `    ${total} people in this group, all riding with you.`
          : `    ${total} people in this group. You're taking ${mine}; the rest go with another driver from the same address. ${first(r?.name)} will sort out who rides with whom.`);
      }
    }
  }
  lines.push(details ? "Please keep these details private and don't forward them. The app has them too." : "Full details with addresses are in the app.");
  return lines.join("\n");
}

export function reminder(sunday) {
  return `Reminder from ${church()}: tomorrow's service is at ${svcLabel()}. If you have a ride, please be ready by the time in your pickup message to avoid delays. If you can't make it, tell us in the app or message the transport leader.`;
}

export function driverCancelled(sunday, rider, newDriver, stop) {
  return newDriver
    ? `Hi ${first(rider.name)}, there's a change to your ride on ${fmtDate(sunday)}. ${first(newDriver.name)} will now pick you up around ${fmtMin(stop.pickupMin)}. Please be ready by ${fmtMin(stop.readyByMin)}. Sorry for the change.`
    : `Hi ${first(rider.name)}, your driver can't make it on ${fmtDate(sunday)} and we're looking for another ride for you. We'll message you shortly.`;
}

export function lastMinuteBroadcast(sunday, riderFirstName, neighbourhood, seatsNeeded = 1) {
  return `Last-minute help needed (${fmtDate(sunday)}): ${riderFirstName}${neighbourhood ? ` in ${neighbourhood}` : ""} needs a ride to church. Can anyone with ${seatsNeeded} free seat pick them up? Please reply to the transport leader.`;
}
