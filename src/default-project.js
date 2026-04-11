export const DEFAULT_PROJECT = {
  version: 4,
  name: "E-Ink Gallery",
  rooms: [
    { id: "living-room", name: "Living Room" }
  ],
  walls: [
    { id: "living-room-living-room-wall", roomId: "living-room", name: "Living Room Wall" }
  ],
  contentLibrary: {
    collections: [],
    sets: [],
    items: {}
  },
  screens: [
    {
      id: "living-room-1",
      name: "Living Room 1",
      roomId: "living-room",
      roomName: "Living Room",
      wallId: "living-room-living-room-wall",
      wallName: "Living Room Wall",
      wallSlot: "left",
      enabled: true,
      profile: "music",
      template: "music-editorial-v1",
      albumSlug: "ten",
      size: { width: 1440, height: 2560 },
      frame: {
        paddingTop: 60,
        paddingRight: 60,
        paddingBottom: 60,
        paddingLeft: 60,
        swatchCount: 5,
        imageFit: "cover"
      },
      device: { host: "192.168.1.201", pin: "123456", mac: "", localIp: "" }
    },
    {
      id: "living-room-2",
      name: "Living Room 2",
      roomId: "living-room",
      roomName: "Living Room",
      wallId: "living-room-living-room-wall",
      wallName: "Living Room Wall",
      wallSlot: "center",
      enabled: true,
      profile: "music",
      template: "music-minimal-v1",
      albumSlug: "daisy",
      size: { width: 1440, height: 2560 },
      frame: {
        paddingTop: 72,
        paddingRight: 72,
        paddingBottom: 72,
        paddingLeft: 72,
        swatchCount: 5,
        imageFit: "contain"
      },
      device: { host: "192.168.1.202", pin: "123456", mac: "", localIp: "" }
    },
    {
      id: "living-room-3",
      name: "Living Room 3",
      roomId: "living-room",
      roomName: "Living Room",
      wallId: "living-room-living-room-wall",
      wallName: "Living Room Wall",
      wallSlot: "right",
      enabled: true,
      profile: "music",
      template: "music-editorial-v1",
      albumSlug: "longform",
      size: { width: 1440, height: 2560 },
      frame: {
        paddingTop: 54,
        paddingRight: 64,
        paddingBottom: 64,
        paddingLeft: 64,
        swatchCount: 5,
        imageFit: "cover"
      },
      device: { host: "192.168.1.203", pin: "123456", mac: "", localIp: "" }
    }
  ]
};
