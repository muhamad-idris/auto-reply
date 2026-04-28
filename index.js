import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
} from "@whiskeysockets/baileys";
import pino from "pino";
import { Boom } from "@hapi/boom";
import readline from "readline";
import fs from "fs";
import express from "express";
import { GoogleGenerativeAI } from "@google/generative-ai";

const app = express();
const port = process.env.PORT || 3000;

// Vercel storage configuration
const isVercel = process.env.VERCEL || process.env.NODE_ENV === "production";
const STORAGE_DIR = isVercel ? "/tmp" : ".";
const SESSION_FILE = `${STORAGE_DIR}/session.json`;
const AUTH_DIR = `${STORAGE_DIR}/auth_info_baileys`;

const SYSTEM_PROMPT = "Jawablah setiap pertanyaan dengan sangat singkat, padat, dan jelas. Hindari basa-basi agar hemat token. Gunakan Bahasa Indonesia. aku memasang kamu di whatsapp, jadi sesuaikan response kamu";

function loadSessions() {
    try {
        if (fs.existsSync(SESSION_FILE)) {
            return JSON.parse(fs.readFileSync(SESSION_FILE, "utf-8"));
        }
    } catch (e) {
        console.error("Error loading sessions:", e);
    }
    return {};
}

function saveSessions(sessions) {
    try {
        fs.writeFileSync(SESSION_FILE, JSON.stringify(sessions, null, 2));
    } catch (e) {
        console.error("Error saving sessions:", e);
    }
}

let chatSessions = loadSessions();

// Use environment variable for API Key
const API_KEY = process.env.GEMINI_API_KEY || "AIzaSyCnONwhUxL4sbkLxqhAMcC18csLJ7joDOM";
const genAI = new GoogleGenerativeAI(API_KEY);
const modelsToTry = [
    "gemini-flash-latest",
    "gemini-flash-lite-latest",
];

async function getAIResponse(prompt, history = []) {
    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({
                model: modelName,
                systemInstruction: SYSTEM_PROMPT
            });

            const chat = model.startChat({
                history: history,
            });

            const result = await chat.sendMessage(prompt);
            const response = await result.response;
            return response.text();
        } catch (error) {
            console.error(`Error with model ${modelName}:`, error.message);
            const errMsg = error.message.toLowerCase();
            if (
                errMsg.includes("429") ||
                errMsg.includes("rate limit") ||
                errMsg.includes("quota exceeded") ||
                errMsg.includes("503") ||
                errMsg.includes("service unavailable") ||
                errMsg.includes("overloaded")
            ) {
                console.log(`Model ${modelName} busy or limited, switching...`);
                continue;
            }
            throw error;
        }
    }
    return "Maaf, semua model AI sedang sibuk atau terkena limit. Silakan coba lagi nanti.";
}

const question = (text) => {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise((resolve) => {
        rl.question(text, (answer) => {
            rl.close();
            resolve(answer);
        });
    });
};

async function connectToWhatsApp() {
    // Check if AUTH_DIR exists locally if not on Vercel
    if (!isVercel && !fs.existsSync(AUTH_DIR)) {
        fs.mkdirSync(AUTH_DIR, { recursive: true });
    }

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    const { version, isLatest } = await fetchLatestBaileysVersion();

    console.log(`using WA v${version.join(".")}, isLatest: ${isLatest}`);

    const sock = makeWASocket({
        version,
        logger: pino({ level: "silent" }),
        printQRInTerminal: false,
        auth: {
            creds: state.creds,
            keys: makeCacheableSignalKeyStore(state.keys, pino({ level: "silent" })),
        },
        browser: ["Ubuntu", "Chrome", "20.0.04"],
    });

    // Pairing code logic
    if (!sock.authState.creds.registered) {
        const phoneNumber = process.env.PHONE_NUMBER;
        if (phoneNumber) {
            setTimeout(async () => {
                try {
                    const code = await sock.requestPairingCode(phoneNumber.trim());
                    console.log(`\nYour Pairing Code: \x1b[32m${code}\x1b[0m\n`);
                } catch (err) {
                    console.error("Error requesting pairing code:", err);
                }
            }, 3000);
        } else {
            if (process.stdin.isTTY) {
                const num = await question("Please enter your mobile number (with country code, e.g. 628xxx): ");
                const code = await sock.requestPairingCode(num.trim());
                console.log(`\nYour Pairing Code: \x1b[32m${code}\x1b[0m\n`);
            } else {
                console.log("No PHONE_NUMBER env found and not in TTY. Cannot request pairing code.");
            }
        }
    }

    sock.ev.on("connection.update", (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === "close") {
            const shouldReconnect = (lastDisconnect.error instanceof Boom) ? lastDisconnect.error.output.statusCode !== DisconnectReason.loggedOut : true;
            console.log("connection closed due to ", lastDisconnect.error, ", reconnecting ", shouldReconnect);
            if (shouldReconnect) {
                connectToWhatsApp();
            }
        } else if (connection === "open") {
            console.log("opened connection");
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // Auto Reply Logic
    sock.ev.on("messages.upsert", async (m) => {
        const msg = m.messages[0];
        if (!msg.message || msg.key.fromMe) return;

        const from = msg.key.remoteJid;
        const type = Object.keys(msg.message)[0];

        let content = "";
        if (type === "conversation") {
            content = msg.message.conversation;
        } else if (type === "extendedTextMessage") {
            content = msg.message.extendedTextMessage.text;
        } else if (type === "imageMessage") {
            content = msg.message.imageMessage.caption;
        } else if (type === "videoMessage") {
            content = msg.message.videoMessage.caption;
        } else if (msg.message.buttonsResponseMessage) {
            content = msg.message.buttonsResponseMessage.selectedButtonId;
        } else if (msg.message.listResponseMessage) {
            content = msg.message.listResponseMessage.singleSelectReply.selectedRowId;
        } else if (msg.message.templateButtonReplyMessage) {
            content = msg.message.templateButtonReplyMessage.selectedId;
        }

        if (!content && (type === "viewOnceMessage" || type === "ephemeralMessage")) {
            const nestedType = Object.keys(msg.message[type].message)[0];
            if (nestedType === "conversation") {
                content = msg.message[type].message.conversation;
            } else if (nestedType === "extendedTextMessage") {
                content = msg.message[type].message.extendedTextMessage.text;
            }
        }

        if (!content) return;

        console.log(`Received message from ${from}: ${content}`);

        const lowerContent = content.toLowerCase();
        const prefix = ".";
        if (lowerContent.startsWith(prefix)) {
            const command = lowerContent.slice(prefix.length).trim();

            if (command === "p" || command === "halo" || command === "hi") {
                await sock.sendMessage(from, { text: "Halo! Saya adalah bot auto-reply. Ada yang bisa dibantu?\n\nKetik *.info* untuk informasi lebih lanjut." });
            } else if (command === "info") {
                await sock.sendMessage(from, { text: "🤖 *Informasi Bot*\n\nBot ini dibuat untuk membantu menjawab pertanyaan pelanggan secara otomatis.\n\nLayanan kami:\n1. Cek Produk\n2. Cek Harga\n3. Cara Order\n\nKetik *.ai [pertanyaan]* untuk bertanya ke AI." });
            } else if (command.startsWith("ai")) {
                const prompt = content.slice(prefix.length + 2).trim();
                if (!prompt) return await sock.sendMessage(from, { text: "Silakan masukkan pertanyaan setelah command .ai\nContoh: *.ai apa itu whatsapp?*" });

                await sock.sendMessage(from, { text: "_Sedang berpikir..._" });
                try {
                    if (!chatSessions[from]) chatSessions[from] = [];

                    const response = await getAIResponse(prompt, chatSessions[from]);

                    chatSessions[from].push({ role: "user", parts: [{ text: prompt }] });
                    chatSessions[from].push({ role: "model", parts: [{ text: response }] });

                    if (chatSessions[from].length > 20) {
                        chatSessions[from] = chatSessions[from].slice(-20);
                    }

                    saveSessions(chatSessions);

                    await sock.sendMessage(from, { text: response });
                } catch (err) {
                    console.error("AI Error:", err);
                    await sock.sendMessage(from, { text: "Terjadi kesalahan saat memproses permintaan Anda." });
                }
            }
        }
    });
}

connectToWhatsApp();

// Express server for Vercel
app.get("/", (req, res) => {
    res.send("WhatsApp Bot is running!");
});

app.listen(port, () => {
    console.log(`Server is listening on port ${port}`);
});
