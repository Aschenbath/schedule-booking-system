<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { api } from '../api';
import { store, loadBootstrap } from '../store';

const form = ref<Record<string, string>>({});
const msg = ref('');
const err = ref('');

async function load() {
  form.value = await api('/settings');
}
async function save() {
  msg.value = '';
  err.value = '';
  try {
    form.value = await api('/settings', { method: 'PUT', body: form.value });
    msg.value = '已保存';
    await loadBootstrap();
  } catch (e: any) {
    err.value = e.message;
  }
}
onMounted(load);
</script>

<template>
  <div style="max-width: 640px">
    <h2>后台设置</h2>
    <div v-if="!store.isBoss" class="alert warn" style="margin-bottom: 12px">只有老板可以修改设置，当前只读。</div>
    <div class="card">
      <label class="field">
        <span>常用地址：公司</span>
        <input class="input" v-model="form.company_address" placeholder="例如：广州市天河区珠江新城华穗路406号" />
      </label>
      <label class="field">
        <span>常用地址：家</span>
        <input class="input" v-model="form.home_address" />
      </label>
      <label class="field">
        <span>提前多少分钟提醒老板</span>
        <input class="input" type="number" min="1" max="1440" v-model="form.reminder_lead_minutes" style="width: 160px" />
      </label>
      <div class="row">
        <label class="field grow">
          <span>工作时间开始（用于推荐空档）</span>
          <input class="input" type="time" v-model="form.work_start" />
        </label>
        <label class="field grow">
          <span>工作时间结束</span>
          <input class="input" type="time" v-model="form.work_end" />
        </label>
      </div>
      <label class="field">
        <span>演示开关</span>
        <label class="row" style="cursor: pointer"><input type="checkbox" :checked="form.map_simulate_failure === '1'" @change="form.map_simulate_failure = ($event.target as HTMLInputElement).checked ? '1' : '0'" /> 模拟地图接口故障（用于演示“车程未核实”）</label>
      </label>
      <div class="row">
        <button class="btn primary" :disabled="!store.isBoss" @click="save">保存</button>
        <span v-if="msg" class="badge ok">{{ msg }}</span>
        <span v-if="err" class="badge danger">{{ err }}</span>
      </div>
    </div>
    <div class="card small muted" style="margin-top: 12px">
      当前时间：{{ store.meta?.now }}（{{ store.meta?.nowOverridden ? '由环境变量 NOW 覆盖' : '真实时间' }}，时区 {{ store.meta?.tz }}）<br />
      大模型：{{ store.meta?.llm === 'openai' ? store.meta?.llmModel : '离线规则模式' }} · 地图：{{ store.meta?.map }}
    </div>
  </div>
</template>
