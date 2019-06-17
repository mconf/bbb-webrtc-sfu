/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const Logger = require('../utils/logger');
const LOG_PREFIX = "[mcs-room]";
const MediaFactory = require('../media/media-factory');
const DEFAULT_MEDIA_SESSION_NAME = 'default';

module.exports = class Room {
  constructor (id) {
    this.id = id;
    this._users = {};
    this._conferenceFloor;
    this._previousConferenceFloors = [];
    this._contentFloor;
    this._previousContentFloors = [];
    this._registeredEvents = [];
    this._mediaSessions = {};
    this._trackContentMediaDisconnection();
    this._trackConferenceMediaDisconnection();
  }

  getUser (id) {
    return this._users[id];
  }

  getUsers () {
    return Object.keys(this._users).map(uk => this._users[uk].getUserInfo());
  }

  /**
   * Media Sessions existent in the room
   * @type {[MediaSession]}
   */
  get mediaSessions () {
    return this._mediaSessions;
  }

  set mediaSessions (_mediaSessions) {
    this._mediaSessions = _mediaSessions;
  }

  setUser (user) {
    this._users[user.id] = user;
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
  }

  getConferenceFloor () {
    const conferenceFloorInfo = {
      floor: this._conferenceFloor? this._conferenceFloor.getMediaInfo() : undefined,
      previousFloor: this._previousConferenceFloors[0]? this._previousConferenceFloors[0].getMediaInfo() : undefined,
    };

    return conferenceFloorInfo;
  }

  getContentFloor () {
    const contentFloorInfo = {
      floor: this._contentFloor? this._contentFloor.getMediaInfo() : undefined,
      previousFloor: this._previousContentFloors[0]? this._previousContentFloors[0].getMediaInfo() : undefined,
    };

    return contentFloorInfo;
  }

  _setPreviousConferenceFloor () {
    this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== this._conferenceFloor.id);
    this._previousConferenceFloors.unshift(this._conferenceFloor);
  }

  setConferenceFloor (media) {
    if (this._conferenceFloor && this._previousConferenceFloor[0] && this._previousConferenceFloor[0].id !== this._conferenceFloor.id) {
      this._setPreviousConferenceFloor();
    }

    this._conferenceFloor = media;
    const conferenceFloorInfo = this.getConferenceFloor();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, ...conferenceFloorInfo });
    return conferenceFloorInfo;
  }

  _setPreviousContentFloor () {
    this._previousContentFloors = this._previousContentFloors.filter(pcf => pcf.id !== this._contentFloor.id);
    this._previousContentFloors.unshift(this._contentFloor);
  }

  setContentFloor (media) {
    if (this._contentFloor && this._previousContentFloors[0] && this._previousContentFloors[0].id !== this._contentFloor.id) {
      this._setPreviousContentFloor();
    }

    this._contentFloor = media.getContentMedia();
    const contentFloorInfo = this.getContentFloor();
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, ...contentFloorInfo });
    return contentFloorInfo;
  }

  releaseConferenceFloor () {
    if (this._conferenceFloor) {
      this._setPreviousConferenceFloor();
      this._conferenceFloor = null
      const conferenceFloorInfo = this.getConferenceFloor();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONFERENCE_FLOOR_CHANGED, { roomId: this.id, ...conferenceFloorInfo});
    }

    return this._previousConferenceFloors[0];
  }

  releaseContentFloor () {
    if (this._contentFloor) {
      this._setPreviousContentFloor();
      this._contentFloor = null;
      const contentFloorInfo = this.getContentFloor();
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.CONTENT_FLOOR_CHANGED, { roomId: this.id, ...contentFloorInfo }) ;
    }

    return this._previousContentFloors[0];
  }

  _registerEvent (event, callback) {
    this._registeredEvents.push({ event, callback });
  }

  _trackContentMediaDisconnection () {
    // Listen for media disconnections and clear the content floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearContentFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      if (roomId === this.id) {
        const { floor } = this.getContentFloor();
        if (floor && (mediaId === floor.mediaId || mediaSessionId === floor.mediaId)) {
          this.releaseContentFloor();
        }

        this._previousContentFloors = this._previousContentFloors.filter(pcf => pcf.id !== mediaId);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, clearContentFloor);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, clearContentFloor);
  }

  _trackConferenceMediaDisconnection () {
    // Listen for media disconnections and clear the conference floor state when needed
    // Used when devices ungracefully disconnect from the system
    const clearConferenceFloor = (event) => {
      const { mediaId, roomId, mediaSessionId } = event;
      if (roomId === this.id) {
        const { floor } = this.getContentFloor();

        if (floor && (mediaId === floor.mediaId || mediaSessionId === floor.mediaId)) {
          this.releaseConferenceFloor();
        }

        this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== mediaId);
      }
    };

    GLOBAL_EVENT_EMITTER.on(C.EVENT.MEDIA_DISCONNECTED, clearConferenceFloor);
    this._registerEvent(C.EVENT.MEDIA_DISCONNECTED, clearConferenceFloor);
  }

  destroyUser(userId) {
    GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_LEFT, { roomId: this.id,  userId });
    if (this._users[userId]) {
      delete this._users[userId];
      if (Object.keys(this._users).length <= 0) {
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.ROOM_EMPTY, this.id);
      }
    }
  }

  destroy () {
    Logger.debug(LOG_PREFIX, "Destroying room", this.id);
    this._registeredEvents.forEach(({ event, callback }) => {
      GLOBAL_EVENT_EMITTER.removeListener(event, callback);
    });
  }

  /**
   * Create a new media session in this room. By default, media sessions
   * of a room are MCU sessions.
   * @param  {String} type        The type of this media session.
   * @return {Object}             A MediaSession object.
   */
  createMediaSession (type, params) {
    try {
      let defaultMediaSession = this.getDefaultMcuMediaSession();
      //TODO: allow more than an unique (default) media session in this room
      if (defaultMediaSession) {
        Logger.info('[room] MCU media \'default\'',
          'already created for this room:', this.id);
        return defaultMediaSession;
      }

      const mediaSession = MediaFactory.createMediaSession(null, type, this.id,
        null, params);

      this._setDefaultMcuMediaSession(mediaSession);

      Logger.info('[room] Created new media session "' + mediaSession.id +
        '" of type "' + type + '" for room "' + this.id + '"');

      return mediaSession;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Remove the session of the room.
   * @param  {String} [mediaSessionId] The id of the media session. Default
   *                                   media session is removed when suppressed.
   */
  removeMediaSession (mediaSessionId) {
    try {
      Logger.info('[room] Removing media session with id:',
        mediaSessionId || DEFAULT_MEDIA_SESSION_NAME);
      if (mediaSessionId && this.mediaSessions[mediaSessionId]) {
        delete this.mediaSessions[mediaSessionId];
      } else {
        delete this.mediaSessions[DEFAULT_MEDIA_SESSION_NAME];
      }
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the current number of MCU users in this room.
   * @return {Int} Current MCU users in this room.
   */
  getNumberOfMcuUsers() {
    try {
      let mcuUsers = this.getUsersByType(C.USERS.MCU);
      return mcuUsers.length;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the MCUSession for the given id. This does not return media sessions
   * from MCU users, but the MCUSession object which represents the current
   * MCU/Mixer of the room.
   * @return {MCUSession} The MCUSession.
   */
  getMcuMediaSession (mcuMediaSessionId) {
    try {
      return this.mediaSessions[mcuMediaSessionId];
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get the default MCUSession of this room.
   * @return {MCUSession} The default MCUSession of this room.
   */
  getDefaultMcuMediaSession () {
    try {
      return this.getMcuMediaSession(DEFAULT_MEDIA_SESSION_NAME);
    } catch (error) {
      throw error;
    }
  }

  /**
   * Set the default MCUSession of this room.
   * @param {MCUSession} mcuSession The MCUSession to be set as default.
   */
  _setDefaultMcuMediaSession (mcuSession) {
    try {
      return this.mediaSessions[DEFAULT_MEDIA_SESSION_NAME] = mcuSession;
    } catch (error) {
      throw error;
    }
  }

  /**
   * Retrieve all SFU media sessions from current room.
   * SFU media sessions are retrieved from all SFU users.
   * @return {MediaSession[]} The SFU media sessions from all SFU users in
   *                          this room.
   */
  getSFUMediaSessions () {
    try {
      let sfuUsers = this.getUsersByType(C.USERS.SFU);

      if (!sfuUsers) {
        return null;
      }


      let sfuMediaSessions = [];
      let _userMediaSessions = null;

      sfuUsers.forEach((_user) => {
        _userMediaSessions = Object.values(_user.mediaSessions || {});
        sfuMediaSessions = sfuMediaSessions.concat(_userMediaSessions);
      });

      return sfuMediaSessions;
    } catch (error){
      throw error;
    }
  }

  /**
   * Retrieves an array containing all the users who match the specified type.
   * @param  {String} type The type of the user ("SFU", "MCU", ...)
   * @return {User[]}      The array of users with the given type.
   */
  getUsersByType (type) {
    try {
      if (!type || typeof(type) != 'string') {
        return null;
      }

      let users = Object.values(this._users || {});
      return users.filter(_user => _user.type === type);
    } catch (error) {
      throw error;
    }
  }

}
