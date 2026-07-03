import { createRoot } from 'react-dom/client';
import '@/shared/pages.css';
import { Sidebar } from './Sidebar';

createRoot(document.getElementById('root')!).render(<Sidebar />);
