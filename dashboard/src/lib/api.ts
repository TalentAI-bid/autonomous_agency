import axios, { type AxiosInstance, type AxiosResponse } from 'axios';
import type { ApiResponse, PaginatedResponse } from '@/types';
import { useAuthStore } from '@/stores/auth.store';

const API_URL = process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000';

// Create axios instance
const axiosInstance: AxiosInstance = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true, // for refresh token cookie
});

let onUnauthorized: (() => void) | null = null;

export function setAuthInterceptors(unauthorizedHandler: () => void) {
  onUnauthorized = unauthorizedHandler;
}

// Request interceptor — read token straight from the store on every request so
// there is no window where a child useQuery effect can fire before a parent
// useEffect assigns the token getter.
axiosInstance.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

// Response interceptor — handle 401 with refresh
let isRefreshing = false;
let refreshQueue: Array<(token: string) => void> = [];

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const original = error.config;
    // CORS-blocked 401s appear as network errors with no response
    const is401 = error.response?.status === 401;
    const isCorsBlocked = !error.response && error.code === 'ERR_NETWORK';
    if ((is401 || isCorsBlocked) && !original._retry) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          refreshQueue.push((token) => {
            original.headers.Authorization = `Bearer ${token}`;
            resolve(axiosInstance(original));
          });
        });
      }

      original._retry = true;
      isRefreshing = true;

      try {
        const res = await axiosInstance.post<{ data: { token: string } }>('/auth/refresh');
        const newToken = res.data.data.token;

        useAuthStore.getState().setToken(newToken);

        refreshQueue.forEach((cb) => cb(newToken));
        refreshQueue = [];
        isRefreshing = false;

        original.headers.Authorization = `Bearer ${newToken}`;
        return axiosInstance(original);
      } catch {
        isRefreshing = false;
        refreshQueue = [];
        onUnauthorized?.();
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  },
);

// Generic API helpers
export async function apiGet<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.get(url, { params });
  return res.data.data;
}

export async function apiGetPaginated<T>(url: string, params?: Record<string, unknown>): Promise<PaginatedResponse<T>> {
  const res: AxiosResponse<PaginatedResponse<T>> = await axiosInstance.get(url, { params });
  return res.data;
}

export async function apiPost<T>(url: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.post(url, data);
  return res.data.data;
}

export async function apiPatch<T>(url: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.patch(url, data);
  return res.data.data;
}

export async function apiPut<T>(url: string, data?: unknown): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.put(url, data);
  return res.data.data;
}

export async function apiDelete<T>(url: string): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.delete(url);
  return res.data.data;
}

export async function apiUpload<T>(url: string, formData: FormData): Promise<T> {
  const res: AxiosResponse<ApiResponse<T>> = await axiosInstance.post(url, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  });
  return res.data.data;
}

export default axiosInstance;
