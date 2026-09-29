import { AxiosInstance } from 'axios';
import { WorkEntry } from './parser.js';

export interface FillEntry {
  date: string; // YYYY-MM-DD
  projectCode: string; // poCode
  activityType: string; // tsTaskName，与 projectCode 共同唯一定位条目
  hours: number;
  workContent: string;
  type?: string; // 工时（默认，工作日）| 加班（非工作日；服务端要求 content 必填=加班原因）——逆向结果 §2
  tsDeliveryType?: string; // 默认 公司远程交付；部门任务忽略
  areaId?: string; // 仅项目地交付两种类型默认取项目地点 pmsId，其余类型不传（DTO areaId=null）
  area?: string; // 缺省按交付类型：公司远程交付=ODC集中交付区域（顺德，6 个办公区域选项第 1 项），项目地交付=项目地点，Base地交付=Base 地名称
}

export interface FillResult {
  date: string;
  projectCode: string;
  success: boolean;
  message: string;
}

// ===== 接口常量：路径与字段以 doc/20260926-ihr接口逆向结果.md 为准 =====
export const IHR_LIST_ENTRIES_PATH = '/attendance/api/pms/WebServices/ChinaSie/AttenterService.asmx/GetBatchTimesheetObjects';
export const IHR_SUBMIT_PATH = '/attendance/api/v1/flow/ts/start';
export const IHR_USER_INFO_PATH = '/core/api/v2/user/info';
export const IHR_STAFF_HEADER_PATH = '/core/api/v1/staff/detail/header';
export const IHR_LOCATION_PATH = '/attendance/api/pms/location';
export const IHR_BASE_NAME_PATH = '/attendance/api/baseName'; // POST <path>/<staffId>，返回 Base 地名称（§3.5）

interface EntrySource {
  taskType: string; poId: string; poCode: string; poName: string;
  tsTaskId: string; tsTaskName: string; startDate: string; endDate: string;
}

interface StaffInfo { staffId: number; staffName: string; deptCode: number; deptName: string }

interface LocationInfo { pmsId: string; area: string; province?: string; city?: string; district?: string }

const fmtDate = (x: Date) =>
  `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`;

// 周一~周日周期起止（填报周期口径，逆向结果 §2）
function weekRange(dateIso: string): { start: string; finish: string } {
  const d = new Date(`${dateIso}T00:00:00`);
  const offset = (d.getDay() + 6) % 7; // 周一=0
  const monday = new Date(d); monday.setDate(d.getDate() - offset);
  const sunday = new Date(monday); sunday.setDate(monday.getDate() + 6);
  return { start: fmtDate(monday), finish: fmtDate(sunday) };
}

// "2026-9月第四周"：X = 当月内以周日结尾的第几段（逆向结果 §2 Pn/Yr 规则，仅作展示/留痕）
function weekCycleLabel(mondayIso: string): string {
  const d = new Date(`${mondayIso}T00:00:00`);
  const cur = new Date(d.getFullYear(), d.getMonth(), 1);
  let seg = 1;
  while (cur < d) {
    if (cur.getDay() === 0) seg++;
    cur.setDate(cur.getDate() + 1);
  }
  const cn = ['一', '二', '三', '四', '五', '六'][seg - 1] ?? String(seg);
  return `${d.getFullYear()}-${d.getMonth() + 1}月第${cn}周`;
}

export class IhrClient {
  private staff?: StaffInfo;
  private sourcesByWeek = new Map<string, EntrySource[]>();
  private locByPoId = new Map<string, LocationInfo>();
  private baseName?: string;
  private succeededWeeks = new Set<string>();

  constructor(private http: AxiosInstance) {}

  // 统一响应包：HTTP 恒 200，errorCode==='0' 才算成功（逆向结果 §0）
  private async call<T>(method: 'get' | 'post', path: string, data?: unknown): Promise<T> {
    // axios get/post 重载签名不同，联合索引调用无法通过 tsc，按 method 分支（get 不传 data）
    const resp = method === 'get' ? await this.http.get(path) : await this.http.post(path, data);
    if (resp.data?.errorCode !== '0') {
      throw new Error(`ihr 接口失败 [errorCode=${resp.data?.errorCode}]: ${resp.data?.errorMsg ?? '未知错误'}`);
    }
    return resp.data.data as T;
  }

  // staffId 来自 user/info，deptCode/deptName 来自 staff/detail/header（逆向结果 §3.1），缓存
  private async getStaff(): Promise<StaffInfo> {
    if (this.staff) return this.staff;
    const info = await this.call<any>('get', IHR_USER_INFO_PATH);
    const header = await this.call<any>('get', `${IHR_STAFF_HEADER_PATH}?staffId=${info.staffId}`);
    this.staff = {
      staffId: Number(info.staffId),
      staffName: info.staffName,
      deptCode: Number(header.deptCode),
      deptName: header.deptName,
    };
    return this.staff;
  }

  // 员工当前 Base 地名称（逆向结果 §3.5），Base地交付与部门任务的 area 数据源，缓存
  private async getBaseName(): Promise<string> {
    if (this.baseName !== undefined) return this.baseName;
    const staff = await this.getStaff();
    this.baseName = (await this.call<string>('post', `${IHR_BASE_NAME_PATH}/${staff.staffId}`)) ?? '';
    return this.baseName;
  }

  // 项目实施地点：POST location，body 为 poId 数组，取首个地点（逆向结果 §3.2），缓存
  private async getLocation(poId: string): Promise<LocationInfo> {
    let loc = this.locByPoId.get(poId);
    if (!loc) {
      const list = await this.call<any[]>('post', IHR_LOCATION_PATH, [poId]);
      const first = list?.[0];
      loc = first
        ? { pmsId: first.pmsId ?? '', area: first.area ?? '', province: first.province, city: first.city, district: first.district }
        : { pmsId: '', area: '' };
      this.locByPoId.set(poId, loc);
    }
    return loc;
  }

  async listEntries(start: string, finish: string): Promise<WorkEntry[]> {
    const staff = await this.getStaff();
    const list = await this.call<EntrySource[]>('post', IHR_LIST_ENTRIES_PATH, {
      userId: String(staff.staffId),
      start,
      finish,
    });
    this.sourcesByWeek.set(`${start}~${finish}`, list);
    return list.map((e) => ({
      projectCode: e.poCode,
      projectName: e.poName,
      activityType: e.tsTaskName,
      taskType: e.taskType,
      poId: e.poId,
      tsTaskId: e.tsTaskId,
      raw: `${e.poCode}|${e.poName}/${e.tsTaskName}`,
    }));
  }

  // 按周一~周日分组，每周一次 start 批量提交（逆向结果 §2）；组内串行，结果逐条返回
  async submitWorkHours(entries: FillEntry[]): Promise<FillResult[]> {
    const results: FillResult[] = [];
    const groups = new Map<string, FillEntry[]>();
    for (const e of entries) {
      const w = weekRange(e.date);
      const key = `${w.start}~${w.finish}`;
      groups.set(key, [...(groups.get(key) ?? []), e]);
    }
    for (const [key, group] of groups) {
      if (this.succeededWeeks.has(key)) {
        // 该周此前已成功提交（401 重登重试复用同一 client 实例时，避免重复提交）
        for (const e of group) {
          results.push({ date: e.date, projectCode: e.projectCode, success: true, message: 'ok（前次已提交）' });
        }
        continue;
      }
      try {
        await this.submitWeek(key, group);
        this.succeededWeeks.add(key);
        for (const e of group) {
          results.push({ date: e.date, projectCode: e.projectCode, success: true, message: 'ok' });
        }
      } catch (err: any) {
        // 401（token 被服务端吊销）穿透给上层 withReauth 重登重试，不转失败结果；其余错误照旧组内失败
        if (/\[errorCode=401\]/.test(String(err?.message))) throw err;
        for (const e of group) {
          results.push({ date: e.date, projectCode: e.projectCode, success: false, message: err?.message || '未知错误' });
        }
      }
    }
    return results;
  }

  private async submitWeek(weekKey: string, group: FillEntry[]): Promise<void> {
    const [start, finish] = weekKey.split('~');
    let sources = this.sourcesByWeek.get(weekKey);
    if (!sources) {
      await this.listEntries(start, finish);
      sources = this.sourcesByWeek.get(weekKey)!;
    }
    const staff = await this.getStaff();
    const details: any[] = [];
    for (const e of group) {
      const src = sources.find((s) => s.poCode === e.projectCode && s.tsTaskName === e.activityType);
      if (!src) throw new Error(`条目未找到: ${e.projectCode}|${e.activityType}（周 ${weekKey}）`);
      const detail: any = {
        ...src,
        staffId: staff.staffId,
        staffName: staff.staffName,
        deptCode: staff.deptCode,
        deptName: staff.deptName,
        hours: e.hours,
        type: e.type ?? '工时', // 非工作日（周末/节假日）报工须传 加班，服务端按当日 swScheduled 校验——逆向结果 §2
        date: e.date,
        content: e.workContent,
      };
      // 交付类型/地点映射（逆向结果 §2 映射表）：仅项目地交付两种类型 areaId 非空
      if (src.taskType === '部门任务') {
        // 部门任务：不渲染交付类型，DTO areaId=null、area=Base 地名称
        detail.area = await this.getBaseName();
      } else {
        const deliveryType = e.tsDeliveryType ?? '公司远程交付';
        detail.tsDeliveryType = deliveryType;
        if (deliveryType === '项目地交付') {
          const loc = await this.getLocation(src.poId);
          detail.areaId = e.areaId ?? loc.pmsId;
          detail.area = e.area ?? loc.area;
          if (!e.areaId) {
            // 前端按 pmsId 匹配地点结果附加省市区（whf.js Ye 实证，§2）
            if (loc.province) detail.province = loc.province;
            if (loc.city) detail.city = loc.city;
            if (loc.district) detail.district = loc.district;
          }
        } else if (deliveryType === '其他项目的项目地交付') {
          // area 选项来自 projectCode≠本项目的地点记录，且 DTO 需另带 otherPoCode（FillEntry 暂无法表达）；
          // 缺显式值时禁止静默回退本条目地点（错误归属风险），该周条目走失败结果
          if (!e.areaId || !e.area) {
            throw new Error('交付类型「其他项目的项目地交付」必须显式提供 areaId 与 area（otherPoCode 暂不支持）');
          }
          detail.areaId = e.areaId;
          detail.area = e.area;
        } else {
          // Base地交付/公司远程交付/居家远程交付：DTO areaId=null，仅调用方显式提供时携带
          if (e.areaId) detail.areaId = e.areaId;
          detail.area = e.area
            ?? (deliveryType === 'Base地交付' ? await this.getBaseName()
              : deliveryType === '公司远程交付' ? 'ODC集中交付区域（顺德）' // 6 个办公区域选项第 1 项（whf.js pr 常量，前端不自动选中，此处固化用户惯选项）
              : deliveryType === '居家远程交付' ? '居家' : undefined); // 居家选项唯一且自动预选（§2），area 必填
        }
      }
      details.push(detail);
    }
    await this.call('post', IHR_SUBMIT_PATH, {
      timeSheetMainDTO: {
        staffId: staff.staffId,
        staffName: staff.staffName,
        deptCode: staff.deptCode,
        deptName: staff.deptName,
        sourceType: 'WEB',
        startDate: start,
        endDate: finish,
        tsDateCycle: weekCycleLabel(start),
      },
      timeSheetDetailDTOList: details,
    });
  }
}
