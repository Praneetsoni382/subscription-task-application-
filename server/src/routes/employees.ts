// ============================================================
// EMPLOYEE ROUTES (WORKSPACE-SCOPED + NO PLAINTEXT PASSWORDS)
// ============================================================

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { adminAuth } from '../firebase.js';
import { userRepo, taskRepo, taskMemberRepo } from '../repositories/firestoreRepository.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { createAuditEvent } from '../services/notificationService.js';

const router = Router();

const createEmployeeSchema = z.object({
  fullName: z.string().min(2, 'Full name is required'),
  employeeId: z.string().min(1, 'Employee ID is required'),
  email: z.string().email('Valid email is required'),
  department: z.string().min(1, 'Department is required'),
  designation: z.string().optional().default(''),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const updateEmployeeSchema = z.object({
  fullName: z.string().min(2).optional(),
  email: z.string().email().optional(),
  department: z.string().min(1).optional(),
  designation: z.string().optional(),
});

// GET /api/employees
router.get(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const { search, department, active } = req.query;

    let employees = (await userRepo.findAllInWorkspace(workspaceId)).filter(
      (u) => u.role === 'employee'
    );

    if (search && typeof search === 'string') {
      const q = search.toLowerCase();
      employees = employees.filter(
        (e) =>
          e.fullName.toLowerCase().includes(q) ||
          e.employeeId.toLowerCase().includes(q) ||
          e.email.toLowerCase().includes(q) ||
          e.department.toLowerCase().includes(q)
      );
    }

    if (department && typeof department === 'string') {
      employees = employees.filter((e) => e.department === department);
    }

    if (active !== undefined) {
      const isActive = active === 'true';
      employees = employees.filter((e) => e.active === isActive);
    }

    const safe = employees.map(({ passwordHash: _, ...e }) => e);
    res.json({ success: true, data: safe });
  })
);

// GET /api/employees/export-csv (Admin ONLY — Directory metadata only, zero passwords)
router.get(
  '/export-csv',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const allUsers = await userRepo.findAllInWorkspace(workspaceId);
    const employees = allUsers.filter((u) => u.role === 'employee');

    let csvContent = 'Employee ID,Full Name,Email,Department,Designation,Role,Status,Created At\n';

    for (const emp of employees) {
      const status = emp.active ? 'Active' : 'Inactive';
      csvContent += `"${emp.employeeId.replace(/"/g, '""')}","${emp.fullName.replace(/"/g, '""')}","${emp.email}","${emp.department.replace(/"/g, '""')}","${(emp.designation || 'Staff').replace(/"/g, '""')}","${emp.role}","${status}","${emp.createdAt}"\n`;
    }

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="taskflow_employees_directory.csv"');
    res.status(200).send(csvContent);
  })
);

// POST /api/employees
router.post(
  '/',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const parse = createEmployeeSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const { fullName, employeeId, email, department, designation, password } = parse.data;
    const normalizedEmail = email.trim().toLowerCase();

    if (await userRepo.findByEmail(normalizedEmail)) {
      res.status(409).json({ success: false, error: 'Email is already registered' });
      return;
    }
    if (await userRepo.findByEmployeeIdInWorkspace(employeeId, workspaceId)) {
      res.status(409).json({ success: false, error: 'Employee ID already exists in this workspace' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await userRepo.create({
      workspaceId,
      employeeId: employeeId.trim(),
      fullName: fullName.trim(),
      email: normalizedEmail,
      department: department.trim(),
      designation: (designation ?? '').trim(),
      role: 'employee',
      active: true,
      passwordHash,
    });

    if (adminAuth) {
      try {
        await adminAuth.createUser({
          uid: user.id,
          email: user.email,
          password,
          displayName: user.fullName,
        });
      } catch (authErr) {
        console.warn('Firebase Auth user creation notice:', authErr instanceof Error ? authErr.message : authErr);
      }
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: req.authUser!.id,
      entityType: 'user',
      entityId: user.id,
      eventType: 'EMPLOYEE_CREATED',
      newState: 'active',
      message: `Employee account created for ${user.fullName} (${user.employeeId})`,
    });

    const { passwordHash: _, ...safeUser } = user;
    res.status(201).json({ success: true, data: safeUser });
  })
);

// GET /api/employees/:id
router.get(
  '/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const user = await userRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!user || user.role !== 'employee') {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    if (req.authUser!.role !== 'admin' && req.authUser!.id !== req.params.id) {
      res.status(403).json({ success: false, error: 'Access denied' });
      return;
    }

    const [taskMembers, tasks] = await Promise.all([
      taskMemberRepo.findByUserInWorkspace(user.id, workspaceId),
      taskRepo.findByMemberInWorkspace(user.id, workspaceId),
    ]);

    const { passwordHash: _, ...safeUser } = user;
    res.json({ success: true, data: { ...safeUser, tasks, taskCount: taskMembers.length } });
  })
);

// PATCH /api/employees/:id
router.patch(
  '/:id',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const user = await userRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!user || user.role !== 'employee') {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    const parse = updateEmployeeSchema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: parse.error.errors[0].message });
      return;
    }

    const updated = await userRepo.update(req.params.id, parse.data);
    if (!updated) {
      res.status(500).json({ success: false, error: 'Update failed' });
      return;
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: req.authUser!.id,
      entityType: 'user',
      entityId: user.id,
      eventType: 'EMPLOYEE_UPDATED',
      message: `Employee profile updated for ${updated.fullName}`,
    });

    const { passwordHash: _, ...safeUser } = updated;
    res.json({ success: true, data: safeUser });
  })
);

// PATCH /api/employees/:id/status
router.patch(
  '/:id/status',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = req.authUser!.workspaceId;
    const user = await userRepo.findByIdInWorkspace(req.params.id, workspaceId);
    if (!user || user.role !== 'employee') {
      res.status(404).json({ success: false, error: 'Employee not found' });
      return;
    }

    const schema = z.object({ active: z.boolean() });
    const parse = schema.safeParse(req.body);
    if (!parse.success) {
      res.status(400).json({ success: false, error: 'Invalid status value' });
      return;
    }

    const updated = await userRepo.update(req.params.id, {
      active: parse.data.active,
      accountStatus: parse.data.active ? 'active' : 'deactivated',
    });
    if (!updated) {
      res.status(500).json({ success: false, error: 'Update failed' });
      return;
    }

    if (adminAuth) {
      try {
        await adminAuth.updateUser(user.id, { disabled: !parse.data.active });
      } catch (authErr) {
        console.warn('Firebase Auth user update notice:', authErr instanceof Error ? authErr.message : authErr);
      }
    }

    await createAuditEvent({
      workspaceId,
      actorUserId: req.authUser!.id,
      entityType: 'user',
      entityId: user.id,
      eventType: 'EMPLOYEE_STATUS_CHANGED',
      previousState: user.active ? 'active' : 'inactive',
      newState: parse.data.active ? 'active' : 'inactive',
      message: `Employee ${updated.fullName} ${parse.data.active ? 'reactivated' : 'deactivated'}`,
    });

    const { passwordHash: _, ...safeUser } = updated;
    res.json({ success: true, data: safeUser });
  })
);

export default router;
