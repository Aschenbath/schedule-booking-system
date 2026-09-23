import type { DB } from '../db';
import { getSetting } from '../db';

export interface LatLng {
  lng: number;
  lat: number;
}

export class MapError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'MapError';
  }
}

/** 地图服务接口：地址转坐标 + 驾车时长（分钟）。调用失败必须抛 MapError，调用方不得当作“已核实”。 */
export interface MapService {
  readonly name: string;
  geocode(address: string): Promise<LatLng>;
  drivingMinutes(from: LatLng, to: LatLng): Promise<number>;
}

export function haversineKm(a: LatLng, b: LatLng): number {
  const R = 6371;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

const DISTRICTS: Array<[string, LatLng]> = [
  ['天河', { lng: 113.33, lat: 23.13 }],
  ['海珠', { lng: 113.31, lat: 23.095 }],
  ['越秀', { lng: 113.27, lat: 23.13 }],
  ['荔湾', { lng: 113.24, lat: 23.115 }],
  ['白云', { lng: 113.28, lat: 23.19 }],
  ['黄埔', { lng: 113.45, lat: 23.16 }],
  ['番禺', { lng: 113.35, lat: 23.0 }],
  ['南沙', { lng: 113.52, lat: 22.8 }],
  ['花都', { lng: 113.22, lat: 23.4 }],
  ['增城', { lng: 113.81, lat: 23.29 }],
  ['从化', { lng: 113.59, lat: 23.55 }],
  ['佛山', { lng: 113.12, lat: 23.02 }],
  ['东莞', { lng: 113.75, lat: 23.02 }],
  ['深圳', { lng: 114.06, lat: 22.54 }],
];

function hash(s: string): number {
  let h = 2166136261;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h;
}

export interface MockMapOptions {
  places: () => Array<{ name: string; address: string; lng: number | null; lat: number | null }>;
  shouldFail?: () => boolean;
  /** 模拟城市平均车速 km/h */
  speedKmh?: number;
}

/**
 * 模拟地图服务：
 *  - 已知地点按名称/地址匹配；含区名的地址落在区中心附近；其余地址按哈希落在广州范围内（同一地址结果稳定）
 *  - 驾车时长 = 球面距离 × 1.35（绕路系数）/ 平均车速 + 8 分钟起步
 *  - shouldFail() 为 true 时抛 MapError（用于演示/测试“车程未核实”）
 */
export class MockMapService implements MapService {
  readonly name = 'mock';
  constructor(private readonly opts: MockMapOptions) {}

  async geocode(address: string): Promise<LatLng> {
    if (this.opts.shouldFail?.()) throw new MapError('模拟地图服务不可用（地址解析失败）');
    const q = address.trim();
    if (!q) throw new MapError('地址为空');
    const places = this.opts.places();
    for (const p of places) {
      if (p.lng == null || p.lat == null) continue;
      if (p.name === q || p.address === q) return { lng: p.lng, lat: p.lat };
    }
    for (const p of places) {
      if (p.lng == null || p.lat == null) continue;
      if (q.includes(p.name) || p.address.includes(q) || (q.length >= 6 && q.includes(p.address))) return { lng: p.lng, lat: p.lat };
    }
    const h = hash(q);
    const jitter = (seed: number, span: number) => ((seed % 1000) / 1000 - 0.5) * span;
    for (const [name, center] of DISTRICTS) {
      if (q.includes(name)) return { lng: center.lng + jitter(h, 0.06), lat: center.lat + jitter(h >>> 8, 0.05) };
    }
    return { lng: 113.2 + (h % 1000) / 1000 * 0.3, lat: 22.95 + ((h >>> 10) % 1000) / 1000 * 0.25 };
  }

  async drivingMinutes(from: LatLng, to: LatLng): Promise<number> {
    if (this.opts.shouldFail?.()) throw new MapError('模拟地图服务不可用（路径规划失败）');
    const km = haversineKm(from, to);
    if (km < 0.3) return 0;
    const speed = this.opts.speedKmh ?? 30;
    return Math.round((km * 1.35) / speed * 60 + 8);
  }
}

/** 高德 Web 服务 API（需 AMAP_KEY） */
export class AmapMapService implements MapService {
  readonly name = 'amap';
  constructor(private readonly key: string, private readonly city = '广州') {}

  async geocode(address: string): Promise<LatLng> {
    const url = `https://restapi.amap.com/v3/geocode/geo?key=${this.key}&address=${encodeURIComponent(address)}&city=${encodeURIComponent(this.city)}`;
    const data = await this.fetchJson(url);
    const loc = data?.geocodes?.[0]?.location as string | undefined;
    if (data?.status !== '1' || !loc) throw new MapError(`高德地址解析失败: ${data?.info ?? 'no result'}`);
    const [lng, lat] = loc.split(',').map(Number);
    return { lng, lat };
  }

  async drivingMinutes(from: LatLng, to: LatLng): Promise<number> {
    const url = `https://restapi.amap.com/v3/direction/driving?key=${this.key}&origin=${from.lng},${from.lat}&destination=${to.lng},${to.lat}&strategy=10`;
    const data = await this.fetchJson(url);
    const sec = Number(data?.route?.paths?.[0]?.duration);
    if (data?.status !== '1' || !Number.isFinite(sec)) throw new MapError(`高德路径规划失败: ${data?.info ?? 'no result'}`);
    return Math.ceil(sec / 60);
  }

  private async fetchJson(url: string): Promise<any> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new MapError(`高德接口 HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      if (e instanceof MapError) throw e;
      throw new MapError('高德接口调用失败', e);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** 测试用：总是失败 */
export class FailingMapService implements MapService {
  readonly name = 'failing';
  async geocode(): Promise<LatLng> {
    throw new MapError('地图服务不可用（测试注入）');
  }
  async drivingMinutes(): Promise<number> {
    throw new MapError('地图服务不可用（测试注入）');
  }
}

export function createMapService(db: DB, provider: 'mock' | 'amap', amapKey: string): MapService {
  if (provider === 'amap' && amapKey) return new AmapMapService(amapKey);
  return new MockMapService({
    places: () => db.prepare('SELECT name, address, lng, lat FROM places').all() as any,
    shouldFail: () => getSetting(db, 'map_simulate_failure', '0') === '1',
  });
}

/** 生成“一点就打开地图导航”的链接（高德 URI API，手机/网页均可打开） */
export function navigationUrl(address: string, coord?: LatLng | null): string {
  if (coord) return `https://uri.amap.com/navigation?to=${coord.lng},${coord.lat},${encodeURIComponent(address)}&mode=car&src=boss-scheduler`;
  return `https://uri.amap.com/search?keyword=${encodeURIComponent(address)}&src=boss-scheduler`;
}
