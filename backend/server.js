const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

const PORT = process.env.PORT || 5000;

// In-memory sessions
const sessions = {}; // sessionId -> { history: [], users: [ { username, socketId } ] }
const userSocketMap = new Map(); // socketId -> { sessionId, username }
const sessionCleanupTimeouts = new Map();

io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("join-session", ({ sessionId, username }, callback) => {
        if (!sessionId || !username) {
            socket.emit("error-message", "Invalid session or username");
            return;
        }

        socket.join(sessionId);
        console.log(`${username} joined session: ${sessionId}`);

        if (!sessions[sessionId]) {
            sessions[sessionId] = {
                history: [],
                users: [],
                activityLog: [],
            };
        }
        if (sessionCleanupTimeouts.has(sessionId)) {
            clearTimeout(sessionCleanupTimeouts.get(sessionId));
            sessionCleanupTimeouts.delete(sessionId);
        }
        socket.emit("activity-log-update", sessions[sessionId].activityLog);

        // Avoid duplicate usernames per socket
        const userExists = sessions[sessionId].users.find(
            (u) => u.username === username && u.socketId === socket.id
        );
        if (!userExists) {
            sessions[sessionId].users.push({ username, socketId: socket.id });
        }

        userSocketMap.set(socket.id, { sessionId, username });

        // Send history and users list to the newly joined client
        socket.emit("init-canvas", sessions[sessionId].history);
        io.to(sessionId).emit(
            "session-users",
            sessions[sessionId].users.map((u) => u.username)
        );
        io.to(sessionId).emit("user-joined", { username });
        callback({ success: true });
        logActivity(sessionId, `${username} joined the session`);
    });

    socket.on(
        "draw",
        ({ sessionId, x0Norm, y0Norm, x1Norm, y1Norm, username, color }) => {
            if (!sessionId || !sessions[sessionId]) return;

            const drawData = {
                x0Norm,
                y0Norm,
                x1Norm,
                y1Norm,
                username,
                color,
            };
            sessions[sessionId].history.push(drawData);
            socket.to(sessionId).emit("draw", drawData);
        }
    );

    socket.on("clear", (sessionId) => {
        if (!sessionId || !sessions[sessionId]) return;

        const user = userSocketMap.get(socket.id);
        const username = user?.username || "Unknown";

        sessions[sessionId].history = [];
        io.to(sessionId).emit("clear");
        logActivity(sessionId, `${username} cleared the canvas`);
    });

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);

        const userData = userSocketMap.get(socket.id);
        if (userData) {
            const { sessionId, username } = userData;
            const session = sessions[sessionId];

            if (session) {
                session.users = session.users.filter(
                    (u) => u.socketId !== socket.id
                );

                if (session.users.length === 0) {
                    // Schedule session deletion after 1 hour (3600000 ms)
                    const timeoutId = setTimeout(() => {
                        delete sessions[sessionId];
                        sessionCleanupTimeouts.delete(sessionId);
                        console.log(
                            `Session ${sessionId} deleted due to inactivity.`
                        );
                    }, 3600000); // 1 hour in milliseconds

                    sessionCleanupTimeouts.set(sessionId, timeoutId);
                } else {
                    io.to(sessionId).emit("user-left", { username });
                    io.to(sessionId).emit(
                        "session-users",
                        session.users.map((u) => u.username)
                    );
                }
            }

            userSocketMap.delete(socket.id);

            if (session) {
                logActivity(sessionId, `${username} left the session`);
            }
        }
    });
});

function logActivity(sessionId, message) {
    const timestamp = new Date().toISOString();
    const logEntry = { message, timestamp };
    sessions[sessionId]?.activityLog.push(logEntry);
    if (sessions[sessionId]) {
        io.to(sessionId).emit(
            "activity-log-update",
            sessions[sessionId].activityLog
        );
    }
}

app.get("/", (req, res) => {
    res.send("Virtual Whiteboard Backend is running.");
});

server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
