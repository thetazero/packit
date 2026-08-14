import "./style.css";
import { initSender } from "./sender";
import { initReceiver } from "./receiver";
import { registerSW } from "virtual:pwa-register";

registerSW({ immediate: true });

const sendView = document.querySelector<HTMLElement>("#send-view")!;
const receiveView = document.querySelector<HTMLElement>("#receive-view")!;
const tabSend = document.querySelector<HTMLButtonElement>("#tab-send")!;
const tabReceive = document.querySelector<HTMLButtonElement>("#tab-receive")!;

initSender(sendView);
initReceiver(receiveView);

function showTab(tab: "send" | "receive"): void {
  sendView.classList.toggle("hidden", tab !== "send");
  receiveView.classList.toggle("hidden", tab !== "receive");
  tabSend.classList.toggle("active", tab === "send");
  tabReceive.classList.toggle("active", tab === "receive");
}

tabSend.addEventListener("click", () => showTab("send"));
tabReceive.addEventListener("click", () => showTab("receive"));
