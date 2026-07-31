import axios from 'axios';

/**
 * Build a minimal magnet URI from an info hash.
 * NO trackers are included — this app uses the TorBox debrid service exclusively.
 * Torrenting/P2P never happens on this machine.
 */
export function buildMagnet(infoHash: string, title?: string | null): string {
  let magnet = `magnet:?xt=urn:btih:${infoHash}`;
  if (title) {
    magnet += `&dn=${encodeURIComponent(title)}`;
  }
  return magnet;
}

export function extractHashFromMagnet(magnet: string): string | null {
  let match = magnet.match(/btih:([a-fA-F0-9]{40})/);
  if (match) return match[1].toLowerCase();
  
  match = magnet.match(/btih:([a-zA-Z2-7]{32})/);
  if (match) return match[1].toLowerCase();
  
  return null;
}

export class JackettAPI {
  private url: string;
  private apiKey: string;

  constructor(url: string, apiKey: string) {
    this.url = url.replace(/\/+$/, '');
    this.apiKey = apiKey;
  }

  async testConnection(): Promise<boolean> {
    const testUrl = `${this.url}/api/v2.0/indexers/all/results/torznab/api`;
    try {
      const resp = await axios.get(testUrl, {
        params: { apikey: this.apiKey, t: 'caps' },
        timeout: 10000,
      });
      return resp.status === 200;
    } catch (error) {
      throw new Error(`Jackett test failed: ${error}`);
    }
  }

  async search(query: string, limit: number = 100, offset: number = 0): Promise<any[]> {
    const searchUrl = `${this.url}/api/v2.0/indexers/all/results/torznab/api`;
    try {
      const resp = await axios.get(searchUrl, {
        params: {
          apikey: this.apiKey,
          t: 'search',
          q: query,
          limit,
          offset,
        },
        timeout: 60000,
        responseType: 'text',
      });
      return this._parseXml(resp.data);
    } catch (error) {
      throw new Error(`Jackett search failed: ${error}`);
    }
  }

  private _parseXml(content: string): any[] {
    const { XMLParser } = require('fast-xml-parser');
    const results: any[] = [];
    
    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: "@_",
      textNodeName: "#text",
      allowBooleanAttributes: true,
      parseTagValue: false
    });
    
    let doc;
    try {
      doc = parser.parse(content);
    } catch (e) {
      throw new Error(`Jackett XML parse failed: ${e}`);
    }
    
    if (doc.error) {
      throw new Error(`Jackett: ${doc.error['@_description'] || 'Unknown Error'}`);
    }
    
    const channel = doc?.rss?.channel;
    if (!channel) return results;
    
    let items = channel.item;
    if (!items) return results;
    if (!Array.isArray(items)) items = [items];
    
    for (const item of items) {
      const getText = (val: any) => {
        if (!val) return null;
        if (typeof val === 'object') return val['#text'];
        return String(val);
      };
      
      const title = getText(item.title) || 'Unknown';
      const size = getText(item.size) || '0';
      const indexer = getText(item.jackettindexer) || item['@_jackettindexer'] || 'Unknown';
      
      let seeders = 0;
      let peers = 0;
      let infoHash: string | null = null;
      let attrMagnet: string | null = null;
      
      let attrs = item['torznab:attr'] || item['newznab:attr'] || item.attr;
      if (attrs) {
        if (!Array.isArray(attrs)) attrs = [attrs];
        for (const attr of attrs) {
          const name = attr['@_name'];
          const value = attr['@_value'];
          if (name === 'seeders') seeders = parseInt(value) || 0;
          else if (name === 'peers') peers = parseInt(value) || 0;
          else if (name === 'infohash') infoHash = value;
          else if (name === 'magneturl' || name === 'magnet') attrMagnet = value;
        }
      }
      
      const candidates: any[] = [];
      if (item.link) candidates.push(item.link);
      
      if (item.guid) {
        if (typeof item.guid === 'object' && item.guid['#text']) candidates.push(item.guid['#text']);
        else if (typeof item.guid === 'string') candidates.push(item.guid);
      }
      
      if (attrMagnet) candidates.push(attrMagnet);
      
      let enclosures = item.enclosure;
      if (enclosures) {
        if (!Array.isArray(enclosures)) enclosures = [enclosures];
        for (const enc of enclosures) {
          if (enc['@_url']) candidates.push(enc['@_url']);
        }
      }
      
      let magnet: string | null = null;
      for (const c of candidates) {
        if (typeof c === 'string' && c.trim().toLowerCase().startsWith('magnet:?')) {
          const mag = c.trim();
          if (extractHashFromMagnet(mag)) {
            magnet = mag;
            break;
          }
        }
      }
      
      if (!magnet && infoHash && typeof infoHash === 'string' && infoHash.trim()) {
        magnet = buildMagnet(infoHash.trim(), title);
      }
      
      if (!magnet) {
        continue;
      }
      
      results.push({
        title,
        size,
        seeders,
        peers,
        link: magnet,
        indexer,
        info_hash: infoHash || extractHashFromMagnet(magnet)
      });
    }
    
    return results;
  }
}
