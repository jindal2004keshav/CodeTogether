import { rooms, socketToRoomMap, initializeRoomState, cleanupRoom } from './state.js';
import { createRouter } from './mediasoup.js';

const MAX_CHAT_MESSAGES = 200;

const sendUpdatedUserList = (io, roomId) => {
    if (rooms[roomId]) {
        const userList = Array.from(rooms[roomId].users.entries()).map(([id, user]) => ({
            id,
            name: user.name,
            handRaised: !!user.handRaised,
        }));
        io.to(roomId).emit('update-user-list', userList);
    }
};

const handleLeaveRoom = (io, socket) => {
    const roomId = socketToRoomMap.get(socket.id);
    if (!roomId || !rooms[roomId]) return;

    const room = rooms[roomId];
    const user = room.users.get(socket.id);
    const username = user?.name;

    console.log(`Cleaning up for user ${username} (${socket.id}) in room ${roomId}`);

    if (room.peers[socket.id]) {
        room.peers[socket.id].transports.forEach(transport => transport.close());
        delete room.peers[socket.id];
    }

    room.users.delete(socket.id);
    socketToRoomMap.delete(socket.id);
    socket.leave(roomId);
    
    console.log(`User ${username} left room ${roomId}. Users left: ${room.users.size}`);
    if (username) {
        socket.to(roomId).emit("user-left", { socketId: socket.id, name: username });
        io.to(roomId).emit("hand-raise-update", { userId: socket.id, handRaised: false, name: username });
    }

    if (room.users.size === 0) {
        cleanupRoom(roomId);
    } else {
        sendUpdatedUserList(io, roomId);
    }
};

export const initializeRoomHandlers = (io, socket) => {
    socket.on("create-room", async (roomId, name, callback) => {
        if (rooms[roomId]) {
            return callback({ success: false, message: "Room already exists." });
        }
        try {
            const router = await createRouter();
            socket.join(roomId);
            socketToRoomMap.set(socket.id, roomId);
            
            initializeRoomState(roomId, router);
            rooms[roomId].users.set(socket.id, { name, handRaised: false });
            rooms[roomId].peers[socket.id] = { transports: [], producers: [], consumers: [] };
            
            const currentUserList = Array.from(rooms[roomId].users.entries()).map(([id, user]) => ({
                id,
                name: user.name,
                handRaised: !!user.handRaised,
            }));

            console.log(`User ${name} created and joined room ${roomId}`);
            callback({ success: true, roomId, message: "Room created", users: currentUserList, messages: rooms[roomId].messages });
            sendUpdatedUserList(io, roomId);
        } catch (error) {
            console.error("Error creating room:", error);
            callback({ success: false, message: "Error creating room." });
        }
    });

    socket.on("join-room", async (roomId, name, callback) => {
        if (!rooms[roomId]) return callback({ success: false, message: "Room not found." });
        // if (socketToRoomMap.has(socket.id)) {
        //     handleLeaveRoom(io, socket);
        // }

        const currentRoomId = socketToRoomMap.get(socket.id);

        if (currentRoomId === roomId) {
            console.log(`User ${name} (${socket.id}) sent a redundant join request for the same room ${roomId}.`);
            const currentUserList = Array.from(rooms[roomId].users.entries()).map(([id, user]) => ({
                id,
                name: user.name,
                handRaised: !!user.handRaised,
            }));
            return callback({ 
                success: true, 
                roomId, 
                message: "Already in room",
                users: currentUserList 
            });
        }
        // If the user is in a different room, make them leave that one first.
        if (currentRoomId) {
            handleLeaveRoom(io, socket);
        }
        
        socket.join(roomId);
        socketToRoomMap.set(socket.id, roomId);
        rooms[roomId].users.set(socket.id, { name, handRaised: false });
        rooms[roomId].peers[socket.id] = { transports: [], producers: [], consumers: [] };

        console.log(`User ${name} joined room ${roomId}`);
        socket.to(roomId).emit("user-joined", { socketId: socket.id, name });
        
        const currentUserList = Array.from(rooms[roomId].users.entries()).map(([id, user]) => ({
            id,
            name: user.name,
            handRaised: !!user.handRaised,
        }));
        callback({ 
            success: true, 
            roomId, 
            message: "Room joined",
            users: currentUserList,
            messages: rooms[roomId].messages 
        });
        
        sendUpdatedUserList(io, roomId);
    });

    socket.on("leave-room", () => handleLeaveRoom(io, socket));
    socket.on("toggle-hand-raise", ({ handRaised }, callback) => {
        const roomId = socketToRoomMap.get(socket.id);
        if (!roomId || !rooms[roomId]) {
            callback?.({ success: false, message: "Room not found" });
            return;
        }
        const user = rooms[roomId].users.get(socket.id);
        if (!user) {
            callback?.({ success: false, message: "User not in room" });
            return;
        }
        user.handRaised = !!handRaised;
        io.to(roomId).emit("hand-raise-update", {
            userId: socket.id,
            handRaised: user.handRaised,
            name: user.name,
        });
        sendUpdatedUserList(io, roomId);
        callback?.({ success: true });
    });
    socket.on("chat-send-message", ({ message }, callback) => {
        const roomId = socketToRoomMap.get(socket.id);
        if (!roomId || !rooms[roomId]) {
            callback?.({ success: false, message: "Room not found" });
            return;
        }

        const text = typeof message === "string" ? message.trim() : "";
        if (!text) {
            callback?.({ success: false, message: "Message cannot be empty" });
            return;
        }

        const user = rooms[roomId].users.get(socket.id);
        const newMessage = {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            userId: socket.id,
            name: user?.name || "Anonymous",
            message: text.slice(0, 1000),
            timestamp: Date.now(),
        };

        rooms[roomId].messages.push(newMessage);
        if (rooms[roomId].messages.length > MAX_CHAT_MESSAGES) {
            rooms[roomId].messages.splice(0, rooms[roomId].messages.length - MAX_CHAT_MESSAGES);
        }

        io.to(roomId).emit("chat-message", newMessage);
        callback?.({ success: true });
    });

    socket.on("window-visibility-change", ({ isHidden }) => {
        const roomId = socketToRoomMap.get(socket.id);
        if (!roomId || !rooms[roomId]) {
            return;
        }

        const user = rooms[roomId].users.get(socket.id);
        if (!user) {
            return;
        }

        // Broadcast to other users in the room (excluding the sender)
        socket.to(roomId).emit("window-visibility-change", {
            userId: socket.id,
            name: user.name,
            isHidden: !!isHidden,
            timestamp: Date.now(),
        });
    });

    socket.on("disconnect", (reason) => {
        console.log(`User disconnected: ${socket.id}, reason: ${reason}`);
        handleLeaveRoom(io, socket);
    });
};