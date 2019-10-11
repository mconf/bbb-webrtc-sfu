/**
 * @classdesc
 * BigBlueButton redis gateway for bbb-screenshare node app
 */

'use strict';

/* Modules */

const C = require('../messages/Constants.js');
const RedisWrapper = require('./RedisWrapper.js');
const config = require('config');
const util = require('util');
const EventEmitter = require('events').EventEmitter;
const Logger = require('../../utils/Logger');
const LOG_PREFIX = '[BigBlueButtonGW]'

let instance = null;

module.exports = class BigBlueButtonGW extends EventEmitter {
  constructor() {
    if(!instance){
      super();
      this.subscribers = {};
      this.publisher = null;
      this.mcsRoomIDs = {};
      instance = this;
    }

    return instance;
  }

  addSubscribeChannel (channel) {
    if (this.subscribers[channel]) {
      return this.subscribers[channel];
    }

    let wrobj = new RedisWrapper(channel);
    this.subscribers[channel] = {};
    this.subscribers[channel] = wrobj;
    try {
      wrobj.startSubscriber();
      wrobj.on(C.REDIS_MESSAGE, this.incomingMessage.bind(this));
      Logger.info(LOG_PREFIX,  `Added subscriber redis client for channel ${channel}`);
      return Promise.resolve(wrobj);
    }
    catch (error) {
      return Promise.reject(LOG_PREFIX, `Could not start redis client for channel ${channel}`);
    }
  }

  /**
   * Capture messages from subscribed channels and emit an event with it's
   * identifier and payload. Check Constants.js for the identifiers.
   *
   * @param {Object} message  Redis message
   */
  incomingMessage (message) {
    let header;
    let payload;
    let msg = (typeof message !== 'object')?JSON.parse(message):message;
    let meetingId;

    // Trying to parse both message types, 1x and 2x
    if (msg.header) {
      header = msg.header;
      payload = msg.payload;
    }
    else if (msg.core) {
      header = msg.core.header;
      payload = msg.core.body;
    }

    if (header){
      switch (header.name) {
        // interoperability with 1.1
        case C.START_TRANSCODER_REPLY:
          meetingId = payload[C.MEETING_ID];
          this.emit(C.START_TRANSCODER_REPLY+meetingId, payload);
          break;
        case C.STOP_TRANSCODER_REPLY:
          meetingId = payload[C.MEETING_ID];
          this.emit(C.STOP_TRANSCODER_REPLY+meetingId, payload);
          break;
        case C.DISCONNECT_ALL_USERS:
          this.emit(C.DISCONNECT_ALL_USERS, payload);
          break;
        case C.DISCONNECT_USER:
          this.emit(C.DISCONNECT_USER, payload);
          break;
          // 2x messages
        case C.START_TRANSCODER_RESP_2x:
          meetingId = header[C.MEETING_ID_2x];
          payload[C.MEETING_ID_2x] = meetingId;
          this.emit(C.START_TRANSCODER_RESP_2x+meetingId, payload);
          break;
        case C.STOP_TRANSCODER_RESP_2x:
          meetingId = header[C.MEETING_ID_2x];
          payload[C.MEETING_ID_2x] = meetingId;
          this.emit(C.STOP_TRANSCODER_RESP_2x+meetingId, payload);
          break;
        case C.USER_CAM_BROADCAST_STARTED_2x:
          this.emit(C.USER_CAM_BROADCAST_STARTED_2x, payload);
          break;
        case C.RECORDING_STATUS_REPLY_MESSAGE_2x:
          meetingId = header[C.MEETING_ID_2x];
          this.emit(C.RECORDING_STATUS_REPLY_MESSAGE_2x+meetingId, payload);
          break;
        case C.DISCONNECT_ALL_USERS_2x:
          payload[C.MEETING_ID_2x] = header[C.MEETING_ID_2x];
          this.emit(C.DISCONNECT_ALL_USERS_2x, payload);
          break;
        case C.PRESENTER_ASSIGNED_2x:
          meetingId = header[C.MEETING_ID_2x];
          payload[C.MEETING_ID_2x] = meetingId;
          this.emit(C.PRESENTER_ASSIGNED_2x+meetingId, payload);
          break;
        case C.PRESENTER_UNASSIGNED_2x:
          meetingId = header[C.MEETING_ID_2x];
          payload[C.MEETING_ID_2x] = meetingId;

          if (this.mcsRoomIDs[meetingId]) {
            payload[C.VOICE_CONF] = this.mcsRoomIDs[meetingId];
            this.emit(C.PRESENTER_UNASSIGNED_2x, payload);
          }
          break;
        case C.USER_JOINED_VOICE_CONF_MESSAGE_2x:
          payload.meetingId = header.meetingId;
          payload.userId = header.userId;
          this.emit(C.USER_JOINED_VOICE_CONF_MESSAGE_2x, payload);
          break;
        case C.USER_LEFT_MEETING_2x:
          payload.meetingId = header.meetingId;
          payload.userId = header.userId;
          this.emit(C.USER_LEFT_MEETING_2x, payload);
          break;
        case C.MEETING_CREATED_2x:
          if (payload.props && payload.props.meetingProp &&
            payload.props.meetingProp.intId &&
            payload.props.voiceProp.voiceConf ) {
            Logger.trace(LOG_PREFIX, `Received ${C.MEETING_CREATED_2x}`, {
              voiceConf: payload.props.voiceProp.voiceConf,
              internalMeetingId: payload.props.meetingProp.intId
            });

            this.mcsRoomIDs[payload.props.meetingProp.intId] =
              payload.props.voiceProp.voiceConf;
          }
        default:
          this.emit(C.GATEWAY_MESSAGE, msg);
      }
    }
    else {
      this.emit(C.GATEWAY_MESSAGE, msg);
    }
  }

  publish (message, channel) {
    if (!this.publisher) {
      this.publisher = new RedisWrapper();
      this.publisher.startPublisher();
    }

    if (typeof this.publisher.publishToChannel === 'function') {
      this.publisher.publishToChannel(message, channel);
    }
  }

  writeMeetingKey(meetingId, message, callback) {
    const EXPIRE_TIME = config.get('redisExpireTime');
    if (!this.publisher) {
      this.publisher = new RedisWrapper();
      this.publisher.startPublisher();
    }

    let recKey = 'recording:' + meetingId;

    this.publisher.setKeyWithIncrement(recKey, message, (err, msgId) => {

      this.publisher.pushToList('meeting:' + meetingId + ':recordings', msgId);

      // Not implemented yet
      this.publisher.expireKey(recKey + ':' + msgId, EXPIRE_TIME, (err) => {
        Logger.info(LOG_PREFIX, `Recording key will expire in ${EXPIRE_TIME} seconds`, { error: err });
      });
    });
  }

  async isChannelAvailable (channel) {
    const channels = await this.publisher.getChannels();
    return channels.includes(channel);
  }

  getChannels () {
    return this.publisher.getChannels();
  }

  setEventEmitter (emitter) {
    this.emitter = emitter;
  }
}
