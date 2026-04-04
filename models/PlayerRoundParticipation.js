const mongoose = require('mongoose');
const { Schema } = mongoose;

const PlayerRoundParticipationSchema = new Schema({
  walletAddress: { type: String, required: true, index: true },
  roundId: { type: String, required: true, index: true },
  tournamentId: { type: String },

  // The coins the player had when they first started this round
  baselineCoin: { type: Number, default: 0 },

  // The points accumulated DURING this round (delta)
  roundPoints: { type: Number, default: 0 },

  // Extra stats per round
  kills: { type: Number, default: 0 },
  deaths: { type: Number, default: 0 },

  // For metadata or other information
  metadata: { type: Schema.Types.Mixed, default: {} },

  lastUpdated: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Ensure a player can have only one record per round
PlayerRoundParticipationSchema.index({ walletAddress: 1, roundId: 1 }, { unique: true });

module.exports = mongoose.model('PlayerRoundParticipation', PlayerRoundParticipationSchema);
