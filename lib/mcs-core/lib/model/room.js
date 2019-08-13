/**
 * @classdesc
 * Model class for rooms
 */

'use strict'

const C = require('../constants/constants');
const GLOBAL_EVENT_EMITTER = require('../utils/emitter');
const Logger = require('../utils/logger');
const StrategyManager = require('../media/strategy-manager.js');
const MediaFactory = require('../media/media-factory');
const { handleError } = require('../utils/util');
const DEFAULT_MEDIA_SESSION_NAME = 'default';

const LOG_PREFIX = "[mcs-room]";
const MAX_PREVIOUS_FLOORS = 10;

module.exports = class Room {
  constructor (id) {
    this.id = id;
    this.users = {};
    this.mediaSessions = [];
    this.medias = [];
    this._conferenceFloor;
    this._previousConferenceFloors = [];
    this._contentFloor;
    this._previousContentFloors = [];
    this._registeredEvents = [];
    this._trackContentMediaDisconnection();
    this._trackConferenceMediaDisconnection();
    this._strategy = C.STRATEGIES.FREEWILL;
  }

  set strategy (strategy) {
    if (!StrategyManager.isValidStrategy(strategy)) {
      throw C.ERROR.MEDIA_INVALID_TYPE;
    }

    this._strategy = strategy;

    GLOBAL_EVENT_EMITTER.emit(C.EVENT.STRATEGY_CHANGED, this.getInfo());
  }

  get strategy () {
    return this._strategy;
  }

  getInfo () {
    return {
      memberType: C.MEMBERS.ROOM,
      roomId: this.id,
      strategy: this.strategy,
    };
  }

  getUser (id) {
    return this.users[id];
  }

  getUsers () {
    return Object.keys(this.users).map(uk => this.users[uk].getUserInfo());
  }

  addUser (user) {
    const found = user.id in this.users;
    if (!found) {
      this.users[user.id] = user;
      GLOBAL_EVENT_EMITTER.emit(C.EVENT.USER_JOINED, { roomId: this.id, user: user.getUserInfo() });
    }
  }

  addMedia (media) {
    this.medias.push(media);
  }

  getMedia (mediaId) {
    this.medias.find(m => m.id === mediaId);
  }

  removeMedia (mediaId) {
    this.medias = this.medias.filter(m => m.id !== mediaId);
  }

  addMediaSession (mediaSession) {
    this.mediaSessions.push(mediaSession);
    mediaSession.medias.forEach(this.addMedia.bind(this));
  }

  getMediaSession (mediaSessionId) {
    return this.mediaSessions.find(ms => ms.id === mediaSessionId);
  }

  /**
   * Retrieves media session with the given name.
   * If there are more than one media session with the same name, the first
   * media session found in the media sessions's array is returned.
   * @param  {String} mediaSessionName The name of the media session.
   * @return {MediaSession}            MediaSession object of the given session.
   */
  getMediaSessionByName (mediaSessionName) {
    return this.mediaSessions.find(ms => ms.name === mediaSessionName);
  }

  getSourceMediaSessionsOfType (mediaType) {
    return this.mediaSessions.filter(({ medias }) =>
      medias.some(({ mediaTypes }) => mediaTypes[mediaType] && mediaTypes[mediaType] !== 'recvonly')
    );
  }

  getSinkMediaSessionsOfType (mediaType) {
    return this.mediaSessions.filter(({ medias }) =>
      medias.some(({ mediaTypes }) => mediaTypes[mediaType] && mediaTypes[mediaType] !== 'sendonly')
    );
  }

  removeMediaSession (mediaSessionId) {
    const mediaSession = this.getMediaSession(mediaSessionId);
    this.mediaSessions = this.mediaSessions.filter(ms => ms.id !== mediaSessionId);
    mediaSession.medias.forEach(this.removeMedia.bind(this));
  }

  getConferenceFloor () {
    const floor = this._conferenceFloor? this._conferenceFloor.getMediaInfo() : undefined;
    const previousFloor = this._previousConferenceFloors.length <= 0
      ? undefined
      : this._previousConferenceFloors.slice(0, MAX_PREVIOUS_FLOORS).map(m => m.getMediaInfo());


    const conferenceFloorInfo = {
      floor,
      previousFloor
    };

    return conferenceFloorInfo;
  }

  getContentFloor () {
    const floor = this._contentFloor ? this._contentFloor.getMediaInfo() : undefined;
    const previousFloor = this._previousContentFloors.length <= 0
      ? undefined
      : this._previousContentFloors.slice(0, MAX_PREVIOUS_FLOORS).map(m => m.getMediaInfo());


    const contentFloorInfo = {
      floor,
      previousFloor
    };

    return contentFloorInfo;
  }

  getContentFloorMedia() {
    return this._contentFloor ? this._contentFloor : null;
  }

  _setPreviousConferenceFloor () {
    this._previousConferenceFloors = this._previousConferenceFloors.filter(pcf => pcf.id !== this._conferenceFloor.id);
    this._previousConferenceFloors.unshift(this._conferenceFloor);
  }

  setConferenceFloor (media) {
    let tentativeFloor;
    if (this._conferenceFloor && this._previousConferenceFloors[0] && this._previousConferenceFloor[0].id !== this._conferenceFloor.id) {
      this._setPreviousConferenceFloor();
    }

    // Check if the media is audio-only. If it is, check the parent media session for
    // video medias If we can't find it there too, fetch the user's media list
    // and look for a valid video media and set it as the floor.
    // If even then there isn't one, do nothing. This is a case where the user
    // is audio only. We could consider implementing a backlog list in case those
    // users join with video later on and lift them from the backlog back
    // to the conference floors
    if (!media.mediaTypes.video) {
      const { mediaSessionId, userId } = media;
      const floorMediaSession = this.getMediaSession(mediaSessionId);
      const findMediaWithVideo = (mediaSession) => {
        return mediaSession.medias.find(m => {
          return m.mediaTypes.video === 'sendrecv' || m.mediaTypes.video === 'sendonly';
        });
      };

      tentativeFloor = findMediaWithVideo(floorMediaSession);

      if (tentativeFloor == null) {
        const floorUser = this.getUser(userId);
        const userMediaSessions = Object.keys(floorUser.mediaSessions).map(msk => floorUser.getMediaSession(msk));

        tentativeFloor = userMediaSessions.find(ms => {
          const msWV = findMediaWithVideo(ms)
          return !!msWV;
        });
      }
    } else {
      tentativeFloor = media;
    }

    if (tentativeFloor == null) {
      Logger.warn(`${LOG_PREFIX} Could not find a valid video media for the conference ${this.id} floor ${media.id}, do nothing`);
      return;
    }

    this._conferenceFloor = tentativeFloor;
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

  destroyUser (userId) {
    if (this.users[userId]) {
      delete this.users[userId];
      if (Object.keys(this.users).length <= 0) {
        GLOBAL_EVENT_EMITTER.emit(C.EVENT.ROOM_EMPTY, this.id);
      }
    }
  }

  destroy () {
    Logger.debug(LOG_PREFIX, "Destroying room", this.id);

    this._registeredEvents.forEach(({ event, callback }) => {
      GLOBAL_EVENT_EMITTER.removeListener(event, callback);
    });
    this._registeredEvents = [];
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

      this.mediaSessions.push(mediaSession);

      Logger.info('[room] Created new media session "' + mediaSession.id +
        '" of type "' + type + '" for room "' + this.id + '"');

      return mediaSession;
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Remove default MCU Media session
   */
  removeDefaultMcuMediaSession () {
    try {
      return this.removeMediaSessionByName(DEFAULT_MEDIA_SESSION_NAME);
    } catch (error) {
      throw (this._handleError(error));
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
      if (mediaSessionId && this.mediaSessions.some(ms => ms.id === mediaSessionId)) {
        const mediaSession = this.getMediaSession(mediaSessionId);
        this.mediaSessions = this.mediaSessions.filter(ms => ms.id !== mediaSessionId);
        mediaSession.medias.forEach(this.removeMedia.bind(this));
      }
    } catch (error) {
      throw (this._handleError(error));
    }
  }

  /**
   * Remove all Media Sessions which match the given name.
   * @param  {String} mediaSessionName The name of the media session to be
   *                                    removed.
   */
  removeMediaSessionByName(mediaSessionName) {
    this.mediaSessions = this.mediaSessions.filter(
      mediaSession => mediaSession.name != DEFAULT_MEDIA_SESSION_NAME
    );
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
      throw (this._handleError(error));
    }
  }

  /**
   * Get the MCUSession for the given name. This does not return media sessions
   * from MCU users, but the MCUSession object which represents the current
   * MCU/Mixer of the room.
   * @return {MCUSession} The MCUSession.
   */
  getMcuMediaSession (mcuMediaSessionName) {
    try {
      return this.mediaSessions.find(mediaSession =>
        (mediaSession.name === mcuMediaSessionName) &&
        (mediaSession.type ===  C.MEDIA_TYPE.MCU))
    } catch (error) {
      throw (this._handleError(error));
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
      throw (this._handleError(error));
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
      throw (this._handleError(error));
    }
  }

  getContentMedias () {
    try {
      let mcuUsers = this.getUsersByType(C.USERS.MCU);

      if (!mcuUsers) {
        return null;
      }


      let contentMedias = [];
      let _userContentMedias = [];

      mcuUsers.forEach((_user) => {

        _userContentMedias = _user.getContentMedias();
        contentMedias = contentMedias.concat(_userContentMedias);


      });


      return contentMedias;
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
      let users = Object.values(this.users || {});
      return users.filter(_user => _user.type === type);
    } catch (error) {
      throw (this._handleError(C.ERROR.ROOM_INVALID_USERS_TYPE));
    }
  }

  _handleError (error) {
    return handleError(LOG_PREFIX, error);
  }
}
